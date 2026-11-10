import { parentPort, workerData } from 'node:worker_threads'
import { Archive } from '@openzim/libzim'
import { buildArticleChunks, type ZIMArticleRef } from '../utils/zim_article.js'
import type {
  ExtractZIMChunkingStrategy,
  ZIMArchiveMetadata,
  ZIMContentChunk,
} from '../../types/zim.js'

/**
 * [fork: parallel-extraction] Worker thread that reads and parses ZIM articles.
 *
 * Each worker holds its own libzim Archive handle on the same file, so blob
 * reads (the HDD-bound part: one cold cluster read per article) and the HTML
 * parsing of several articles overlap. The pool lives in
 * app/services/zim_extract_pool.ts. Must not import anything that needs the
 * booted Adonis app.
 */

export type ZIMExtractTask = {
  id: number
  articles: ZIMArticleRef[]
  archiveMetadata: ZIMArchiveMetadata
  strategy?: ExtractZIMChunkingStrategy
}

export type ZIMExtractTaskResult =
  | { id: number; ok: true; chunks: ZIMContentChunk[][] }
  | { id: number; ok: false; error: string }

if (parentPort) {
  const port = parentPort
  const archive = new Archive((workerData as { filePath: string }).filePath)

  port.on('message', (task: ZIMExtractTask) => {
    try {
      const chunks = task.articles.map((article) =>
        buildArticleChunks(
          archive.getEntryByPath(article.index).item.data.data,
          article,
          task.archiveMetadata,
          task.strategy
        )
      )
      port.postMessage({ id: task.id, ok: true, chunks } satisfies ZIMExtractTaskResult)
    } catch (err) {
      port.postMessage({
        id: task.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ZIMExtractTaskResult)
    }
  })
}
