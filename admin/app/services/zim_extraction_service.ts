import { Archive, Entry } from '@openzim/libzim'
import { ZIM_PREFETCH_NEXT_BATCH } from '../../constants/zim_extraction.js'
import { buildArticleChunks, type ZIMArticleRef } from '../utils/zim_article.js'
import { closeExtractPool, extractArticlesInParallel, isParallelExtractionAvailable } from './zim_extract_pool.js'
import logger from '@adonisjs/core/services/logger'
import { ExtractZIMContentOptions, ZIMContentChunk, ZIMArchiveMetadata } from '../../types/zim.js'
import { access } from 'node:fs/promises'
import { isValidZimFile } from '../utils/fs.js'

export type ExtractZIMContentResult = {
    chunks: ZIMContentChunk[]
    totalArticles: number
    articlesProcessed: number
    nextEntryIndex: number
}

export class ZIMExtractionService {
    /** Below this many articles a batch is not worth the round trip to the pool. */
    private static MIN_PARALLEL_ARTICLES = 8

    // [fork: parallel-extraction] Batches extracted ahead of time, keyed by
    // file + entry cursor + batch size. At most one per file; an entry nobody
    // collects (cancelled or failed chain) is dropped after PREFETCH_TTL_MS.
    private static PREFETCH_TTL_MS = 10 * 60_000
    private static prefetched = new Map<
        string,
        { filePath: string; result: Promise<ExtractZIMContentResult | null>; timer: NodeJS.Timeout }
    >()

    private static prefetchKey(filePath: string, startEntryIndex: number, batchSize: number) {
        return `${filePath}|${startEntryIndex}|${batchSize}`
    }

    /**
     * Start extracting the batch at `startEntryIndex` in the background so it is
     * (mostly) ready when the continuation job asks for it. Extraction is disk-
     * and CPU-bound, embedding GPU-bound, so the two overlap almost for free.
     */
    static prefetchBatch(filePath: string, startEntryIndex: number, batchSize: number): void {
        if (!ZIM_PREFETCH_NEXT_BATCH || !isParallelExtractionAvailable()) return
        const key = this.prefetchKey(filePath, startEntryIndex, batchSize)
        if (this.prefetched.has(key)) return
        this.discardPrefetched(filePath)

        const result = new ZIMExtractionService()
            .extractZIMContent(filePath, { startEntryIndex, batchSize })
            .catch((error) => {
                logger.warn(
                    `[ZIMExtractionService]: Prefetch at entry ${startEntryIndex} failed: ${error instanceof Error ? error.message : String(error)}`
                )
                return null
            })
        const timer = setTimeout(() => this.prefetched.delete(key), this.PREFETCH_TTL_MS)
        timer.unref()
        this.prefetched.set(key, { filePath, result, timer })
    }

    /** Hand over (and forget) the prefetched batch for this cursor, if there is one. */
    static async takePrefetched(
        filePath: string,
        startEntryIndex: number | undefined,
        batchSize: number
    ): Promise<ExtractZIMContentResult | null> {
        if (typeof startEntryIndex !== 'number') return null
        const key = this.prefetchKey(filePath, startEntryIndex, batchSize)
        const hit = this.prefetched.get(key)
        if (!hit) return null
        clearTimeout(hit.timer)
        this.prefetched.delete(key)
        return hit.result
    }

    /** Drop any prefetched batch of this file. */
    static discardPrefetched(filePath: string): void {
        for (const [key, entry] of this.prefetched) {
            if (entry.filePath === filePath) {
                clearTimeout(entry.timer)
                this.prefetched.delete(key)
            }
        }
    }

    /** Release prefetched data and the worker pool's handles on this file. */
    static releaseFile(filePath: string): void {
        this.discardPrefetched(filePath)
        closeExtractPool(filePath)
    }

    private extractArchiveMetadata(archive: Archive): ZIMArchiveMetadata {
        try {
            return {
                title: archive.getMetadata('Title') || archive.getMetadata('Name') || 'Unknown',
                creator: archive.getMetadata('Creator') || 'Unknown',
                publisher: archive.getMetadata('Publisher') || 'Unknown',
                date: archive.getMetadata('Date') || 'Unknown',
                language: archive.getMetadata('Language') || 'Unknown',
                description: archive.getMetadata('Description') || '',
            }
        } catch (error) {
            logger.warn('[ZIMExtractionService]: Could not extract all metadata, using defaults', error)
            return {
                title: 'Unknown',
                creator: 'Unknown',
                publisher: 'Unknown',
                date: 'Unknown',
                language: 'Unknown',
                description: '',
            }
        }
    }

    /**
     * Breaks out a ZIM file's entries into their structured content form
     * to facilitate better indexing and retrieval.
     * Returns enhanced chunks with full article context and metadata.
     * 
     * @param filePath - Path to the ZIM file
     * @param opts - Options including maxArticles, strategy, onProgress, startOffset, and batchSize
     */
    async extractZIMContent(
        filePath: string,
        opts: ExtractZIMContentOptions = {}
    ): Promise<ExtractZIMContentResult> {
        try {
            logger.info(`[ZIMExtractionService]: Processing ZIM file at path: ${filePath}`)
            
            // defensive - check if file still exists before opening
            // could have been deleted by another process or batch
            try {
                await access(filePath)
            } catch (error) {
                logger.error(`[ZIMExtractionService]: ZIM file not accessible: ${filePath}`)
                throw new Error(`ZIM file not found or not accessible: ${filePath}`)
            }

            // Validate ZIM magic number before opening with native library.
            // A corrupted file causes a native C++ abort that cannot be caught by JS.
            if (!(await isValidZimFile(filePath))) {
                throw new Error(`ZIM file is invalid or corrupted: ${filePath}`)
            }

            const archive = new Archive(filePath)

            // Extract archive-level metadata once
            const archiveMetadata = this.extractArchiveMetadata(archive)
            logger.info(`[ZIMExtractionService]: Archive metadata - Title: ${archiveMetadata.title}, Language: ${archiveMetadata.language}`)

            let articlesSkipped = 0
            const processedPaths = new Set<string>()
            // [fork: parallel-extraction] Phase 1 (the loop below) walks the dirents
            // only and collects the article entries of this batch (~50-100 ms per
            // 200 articles). The expensive part, reading + parsing each blob, is
            // phase 2 and runs on the worker pool.
            const articles: ZIMArticleRef[] = []

            // Support batch processing to avoid lock timeouts on large ZIM files
            const startOffset = opts.startOffset || 0
            const batchSize = opts.batchSize || (opts.maxArticles || Infinity)

            // [fork: zim-entry-cursor] Jump directly to the cursor when the caller
            // knows it; otherwise fall back to the legacy article-count skip (first
            // batch of a resumed/legacy chain), and report the cursor either way.
            const useCursor =
                typeof opts.startEntryIndex === 'number' && opts.startEntryIndex >= 0
            const baseIndex = useCursor ? opts.startEntryIndex! : 0
            const range = useCursor
                ? archive.iterByPath().offset(baseIndex, Math.max(0, archive.entryCount - baseIndex))
                : archive.iterByPath()
            let entryIndex = baseIndex - 1
            let nextEntryIndex = archive.entryCount

            for (const entry of range) {
                entryIndex++
                // Skip articles until we reach the start offset
                if (!useCursor && articlesSkipped < startOffset) {
                    if (this.isArticleEntry(entry) && !processedPaths.has(entry.path)) {
                        articlesSkipped++
                    }
                    continue
                }

                if (articles.length >= batchSize) {
                    nextEntryIndex = entryIndex
                    break
                }

                if (!this.isArticleEntry(entry)) {
                    logger.debug(`[ZIMExtractionService]: Skipping non-article entry at path: ${entry.path}`)
                    continue
                }

                if (processedPaths.has(entry.path)) {
                    logger.debug(`[ZIMExtractionService]: Skipping duplicate entry at path: ${entry.path}`)
                    continue
                }
                processedPaths.add(entry.path)

                articles.push({ index: entryIndex, path: entry.path, title: entry.title })
            }

            // Phase 2: read + parse the blobs, on the worker pool when available.
            let perArticle: ZIMContentChunk[][] | null = null
            if (
                articles.length >= ZIMExtractionService.MIN_PARALLEL_ARTICLES &&
                isParallelExtractionAvailable()
            ) {
                try {
                    perArticle = await extractArticlesInParallel(filePath, articles, archiveMetadata, opts.strategy)
                } catch (error) {
                    logger.warn(
                        `[ZIMExtractionService]: Parallel extraction failed, falling back to serial: ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }
            if (!perArticle) {
                perArticle = articles.map((article) =>
                    buildArticleChunks(
                        archive.getEntryByPath(article.index).item.data.data,
                        article,
                        archiveMetadata,
                        opts.strategy
                    )
                )
            }

            const toReturn: ZIMContentChunk[] = perArticle.flat()
            const articlesProcessed = articles.length
            if (opts.onProgress) {
                for (let done = 1; done <= articlesProcessed; done++) {
                    opts.onProgress(done, archive.articleCount)
                }
            }

            logger.info(`[ZIMExtractionService]: Completed processing ZIM file. Total articles processed: ${articlesProcessed}`)
            logger.debug("Final structured content sample:", toReturn.slice(0, 3).map(c => ({
                articleTitle: c.articleTitle,
                sectionTitle: c.sectionTitle,
                hierarchy: c.hierarchy,
                textPreview: c.text.substring(0, 100)
            })))
            logger.debug("Total structured sections extracted:", toReturn.length)
            return { chunks: toReturn, totalArticles: archive.articleCount, articlesProcessed, nextEntryIndex }
        } catch (error) {
            logger.error('Error processing ZIM file:', error)
            throw error
        }
    }

    private isArticleEntry(entry: Entry): boolean {
        try {
            if (entry.isRedirect) return false;

            const item = entry.item;
            const mimeType = item.mimetype;

            return mimeType === 'text/html' || mimeType === 'application/xhtml+xml';
        } catch {
            return false;
        }
    }
}