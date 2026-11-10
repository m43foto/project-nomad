
export const HTML_SELECTORS_TO_REMOVE = [
    'script',
    'style',
    'nav',
    'header',
    'footer',
    'noscript',
    'iframe',
    'svg',
    '.navbox',
    '.sidebar',
    '.infobox',
    '.mw-editsection',
    '.reference',
    '.reflist',
    '.toc',
    '.noprint',
    '.mw-jump-link',
    '.mw-headline-anchor',
    '[role="navigation"]',
    '.navbar',
    '.hatnote',
    '.ambox',
    '.sistersitebox',
    '.portal',
    '#coordinates',
    '.geo-nondefault',
    '.authority-control',
]

// Common heading names that usually don't have meaningful content under them
export const NON_CONTENT_HEADING_PATTERNS = [
    /^see also$/i,
    /^references$/i,
    /^external links$/i,
    /^further reading$/i,
    /^notes$/i,
    /^bibliography$/i,
    /^navigation$/i,
]

/**
 * Batch size for processing ZIM articles to prevent lock timeout errors.
 * Processing 50 articles at a time balances throughput with job duration.
 * Typical processing time: 2-5 minutes per batch depending on article complexity.
 */
export const ZIM_BATCH_SIZE = positiveIntEnv('NOMAD_ZIM_BATCH_SIZE', 50)

// [fork: batched-embedding] Embedding throughput knobs for bulk ZIM ingestion.
// Defaults measured on an RTX 4090 with nomic-embed-text:v1.5 and ~2.9k-char
// Wikipedia sections: 1 chunk/request = 21 chunks/s, 32 x 4 parallel = 155
// chunks/s; larger requests (64) or more parallelism (8) got slower again.
export const ZIM_EMBED_REQUEST_SIZE = positiveIntEnv('NOMAD_EMBED_REQUEST_SIZE', 32)
export const ZIM_EMBED_CONCURRENCY = positiveIntEnv('NOMAD_EMBED_CONCURRENCY', 4)

// [fork: parallel-extraction] Worker threads that read + parse the articles of
// a batch (1 = extract serially in the queue worker itself). Measured on the
// Wikipedia maxi ZIM on an HDD RAID 1, 200 articles cold: serial 6.5-8 s,
// 4 workers ~3.0 s, 8 ~2.2 s, 16 ~1.9 s, 32 ~1.8 s.
export const ZIM_EXTRACT_WORKERS = positiveIntEnv('NOMAD_ZIM_EXTRACT_WORKERS', 8)

// [fork: parallel-extraction] Extract the next batch while the current one is
// being embedded, so disk/CPU extraction overlaps the GPU phase.
export const ZIM_PREFETCH_NEXT_BATCH =
    (typeof process !== 'undefined' ? process.env?.NOMAD_ZIM_PREFETCH : undefined) !== 'false'

function positiveIntEnv(name: string, fallback: number): number {
    const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined
    const n = raw ? Number.parseInt(raw, 10) : NaN
    return Number.isFinite(n) && n > 0 ? n : fallback
}
