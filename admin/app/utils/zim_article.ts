import * as cheerio from 'cheerio'
import { randomUUID } from 'node:crypto'
import {
  HTML_SELECTORS_TO_REMOVE,
  NON_CONTENT_HEADING_PATTERNS,
} from '../../constants/zim_extraction.js'
import { extractStructuredContent } from './zim_html.js'
import type {
  ExtractZIMChunkingStrategy,
  ZIMArchiveMetadata,
  ZIMContentChunk,
} from '../../types/zim.js'

/**
 * [fork: parallel-extraction] Pure HTML -> chunk conversion for one ZIM article.
 *
 * Lives outside ZIMExtractionService so the extraction worker threads can use
 * it: nothing in here may import the Adonis app (logger, config, models), a
 * worker thread has no booted application.
 */

/** One article entry of a batch, addressed by its raw path-order entry index. */
export type ZIMArticleRef = {
  index: number
  path: string
  title: string
}

export function cleanArticleHTML(buff: Buffer | Uint8Array): string {
  const rawString = Buffer.from(buff.buffer, buff.byteOffset, buff.byteLength).toString('utf-8')
  const $ = cheerio.load(rawString)

  HTML_SELECTORS_TO_REMOVE.forEach((selector) => {
    $(selector).remove()
  })

  return $.html()
}

export function extractTextFromHTML(html: string): string | null {
  try {
    const $ = cheerio.load(html)

    // Search body first, then root if body is absent
    const text = $('body').length ? $('body').text() : $.root().text()

    return text.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim()
  } catch {
    return null
  }
}

/**
 * Simple analysis to determine if the HTML has any meaningful structure that
 * we can leverage for better chunking.
 */
export function hasStructuredHeadings(html: string): boolean {
  const $ = cheerio.load(html)

  const headings = $('h2, h3').toArray()

  // Consider it structured if it has at least 2 headings to break content into meaningful sections
  if (headings.length < 2) return false

  // Check that headings have substantial content between them
  let sectionsWithContent = 0

  for (const heading of headings) {
    const $heading = $(heading)
    const headingText = $heading.text().trim()

    // Skip empty or very short headings, likely not meaningful
    if (headingText.length < 3) continue

    // Skip common non-content headings
    if (NON_CONTENT_HEADING_PATTERNS.some((pattern) => pattern.test(headingText))) {
      continue
    }

    // Content until next heading
    let contentLength = 0
    let $next = $heading.next()

    while ($next.length && !$next.is('h1, h2, h3, h4')) {
      contentLength += $next.text().trim().length
      $next = $next.next()
    }

    // Consider it a real section if it has at least 100 chars of content
    if (contentLength >= 100) {
      sectionsWithContent++
    }
  }

  // Require at least 2 sections with substantial content
  return sectionsWithContent >= 2
}

/**
 * Turn one article's raw HTML blob into its non-empty content chunks. All
 * chunks of the article share a freshly generated documentId.
 */
export function buildArticleChunks(
  blob: Buffer | Uint8Array,
  article: { path: string; title: string },
  archiveMetadata: ZIMArchiveMetadata,
  forcedStrategy?: ExtractZIMChunkingStrategy
): ZIMContentChunk[] {
  const html = cleanArticleHTML(blob)
  const strategy: ExtractZIMChunkingStrategy =
    forcedStrategy || (hasStructuredHeadings(html) ? 'structured' : 'simple')

  const documentId = randomUUID()
  const articleTitle = article.title || article.path

  let chunks: ZIMContentChunk[]

  if (strategy === 'structured') {
    const structured = extractStructuredContent(html)
    chunks = structured.sections.map((s) => ({
      text: s.text,
      articleTitle,
      articlePath: article.path,
      sectionTitle: s.heading,
      fullTitle: `${articleTitle} - ${s.heading}`,
      hierarchy: `${articleTitle} > ${s.heading}`,
      sectionLevel: s.level,
      documentId,
      archiveMetadata,
      strategy,
    }))
  } else {
    // Simple strategy - entire article as one chunk
    const text = extractTextFromHTML(html) || ''
    chunks = [
      {
        text,
        articleTitle,
        articlePath: article.path,
        sectionTitle: articleTitle, // Same as article for simple strategy
        fullTitle: articleTitle,
        hierarchy: articleTitle,
        documentId,
        archiveMetadata,
        strategy,
      },
    ]
  }

  return chunks.filter((c) => c.text.trim().length > 0)
}
