import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ZIM_EXTRACT_WORKERS } from '../../constants/zim_extraction.js'
import type { ZIMArticleRef } from '../utils/zim_article.js'
import type {
  ExtractZIMChunkingStrategy,
  ZIMArchiveMetadata,
  ZIMContentChunk,
} from '../../types/zim.js'
import type { ZIMExtractTask, ZIMExtractTaskResult } from '../workers/zim_extract_worker.js'

/**
 * [fork: parallel-extraction] Pool of worker threads that read and parse the
 * articles of a ZIM batch in parallel.
 *
 * Measured on the Wikipedia maxi ZIM (HDD RAID 1, cold cache), 200 articles:
 * serial 6.5-8 s, 4 workers ~3.0 s, 8 workers ~2.2 s, 16 workers ~1.9 s. The
 * serial time is ~70% cold blob reads, so the gain comes from overlapping
 * disk requests more than from spreading the HTML parsing.
 *
 * One pool per ZIM file (each worker keeps an open Archive on it). Pools are
 * shared by concurrent batches and torn down after IDLE_MS without work so
 * the file handles do not outlive the ingestion.
 */

const WORKER_URL = new URL('../workers/zim_extract_worker.js', import.meta.url)
/** Articles per task: small enough to balance uneven article sizes across workers. */
const SLICE_SIZE = 4
const IDLE_MS = 60_000

type Pending = {
  task: ZIMExtractTask
  resolve: (chunks: ZIMContentChunk[][]) => void
  reject: (err: Error) => void
}

class ZimExtractPool {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private running = new Map<Worker, Pending>()
  private queue: Pending[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private nextId = 1
  private dead = false

  constructor(
    private readonly filePath: string,
    size: number
  ) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(WORKER_URL, { workerData: { filePath } })
      // Never keep the process alive just for an idle pool.
      worker.unref()
      worker.on('message', (result: ZIMExtractTaskResult) => this.onResult(worker, result))
      worker.on('error', (err) => this.destroy(err instanceof Error ? err : new Error(String(err))))
      worker.on('exit', (code) => {
        if (!this.dead) this.destroy(new Error(`ZIM extract worker exited with code ${code}`))
      })
      this.workers.push(worker)
      this.idle.push(worker)
    }
  }

  get isDead() {
    return this.dead
  }

  run(task: Omit<ZIMExtractTask, 'id'>): Promise<ZIMContentChunk[][]> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('ZIM extract pool is closed'))
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
      }
      this.queue.push({ task: { ...task, id: this.nextId++ }, resolve, reject })
      this.pump()
    })
  }

  private pump() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!
      const pending = this.queue.shift()!
      this.running.set(worker, pending)
      worker.postMessage(pending.task)
    }
    if (this.running.size === 0 && this.queue.length === 0 && !this.idleTimer && !this.dead) {
      this.idleTimer = setTimeout(() => this.destroy(), IDLE_MS)
      this.idleTimer.unref()
    }
  }

  private onResult(worker: Worker, result: ZIMExtractTaskResult) {
    const pending = this.running.get(worker)
    if (!pending || pending.task.id !== result.id) return
    this.running.delete(worker)
    this.idle.push(worker)
    if (result.ok) pending.resolve(result.chunks)
    else pending.reject(new Error(result.error))
    this.pump()
  }

  /** Terminate all workers; outstanding tasks reject with `reason`. */
  destroy(reason: Error = new Error('ZIM extract pool closed')) {
    if (this.dead) return
    this.dead = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (pools.get(this.filePath) === this) pools.delete(this.filePath)
    const outstanding = [...this.running.values(), ...this.queue]
    this.running.clear()
    this.queue = []
    for (const pending of outstanding) pending.reject(reason)
    for (const worker of this.workers) void worker.terminate()
  }
}

const pools = new Map<string, ZimExtractPool>()

/**
 * False when parallel extraction is switched off (NOMAD_ZIM_EXTRACT_WORKERS=1)
 * or the compiled worker is not on disk (dev/test runs straight from .ts).
 */
export function isParallelExtractionAvailable(): boolean {
  return ZIM_EXTRACT_WORKERS > 1 && existsSync(fileURLToPath(WORKER_URL))
}

/**
 * Read and parse `articles` on the worker pool of `filePath`. Returns one
 * chunk list per article, in input order. Rejects if a worker fails; the
 * caller is expected to fall back to in-thread extraction.
 */
export async function extractArticlesInParallel(
  filePath: string,
  articles: ZIMArticleRef[],
  archiveMetadata: ZIMArchiveMetadata,
  strategy?: ExtractZIMChunkingStrategy
): Promise<ZIMContentChunk[][]> {
  let pool = pools.get(filePath)
  if (!pool || pool.isDead) {
    pool = new ZimExtractPool(filePath, ZIM_EXTRACT_WORKERS)
    pools.set(filePath, pool)
  }

  const slices: Promise<ZIMContentChunk[][]>[] = []
  for (let i = 0; i < articles.length; i += SLICE_SIZE) {
    slices.push(pool.run({ articles: articles.slice(i, i + SLICE_SIZE), archiveMetadata, strategy }))
  }
  try {
    return (await Promise.all(slices)).flat()
  } catch (err) {
    // Settle the sibling slices so a failed batch leaves no unhandled rejections.
    await Promise.allSettled(slices)
    throw err
  }
}

/** Close the worker pool of a file (e.g. before the file is deleted). */
export function closeExtractPool(filePath: string) {
  pools.get(filePath)?.destroy()
}
