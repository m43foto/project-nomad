import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildArticleChunks, hasStructuredHeadings } from '../../app/utils/zim_article.js'

const META = {
  title: 'Test Archive',
  creator: 'c',
  publisher: 'p',
  date: '2026-01',
  language: 'eng',
  description: '',
}

const LONG = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4)

test('simple strategy: one chunk carrying the whole article, boilerplate removed', () => {
  const html = `<html><body><script>evil()</script><nav>Menu</nav><p>Hello world.</p></body></html>`
  const chunks = buildArticleChunks(Buffer.from(html), { path: 'A/Hello', title: 'Hello' }, META)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].strategy, 'simple')
  assert.equal(chunks[0].text, 'Hello world.')
  assert.equal(chunks[0].articlePath, 'A/Hello')
  assert.equal(chunks[0].fullTitle, 'Hello')
  assert.deepEqual(chunks[0].archiveMetadata, META)
})

test('structured strategy: sections share one documentId', () => {
  const html = `<html><body><p>Intro text.</p>
    <h2>History</h2><p>${LONG}</p>
    <h2>Usage</h2><p>${LONG}</p></body></html>`
  assert.equal(hasStructuredHeadings(html), true)
  const chunks = buildArticleChunks(Buffer.from(html), { path: 'A/Thing', title: 'Thing' }, META)
  assert.deepEqual(
    chunks.map((c) => c.sectionTitle),
    ['Introduction', 'History', 'Usage']
  )
  assert.equal(new Set(chunks.map((c) => c.documentId)).size, 1)
  assert.equal(chunks[1].hierarchy, 'Thing > History')
  assert.ok(chunks.every((c) => c.strategy === 'structured'))
})

test('articles without text yield no chunks; title falls back to the path', () => {
  assert.deepEqual(
    buildArticleChunks(Buffer.from('<html><body><script>x</script></body></html>'), { path: 'A/Empty', title: '' }, META),
    []
  )
  const [chunk] = buildArticleChunks(Buffer.from('<p>Text</p>'), { path: 'A/NoTitle', title: '' }, META)
  assert.equal(chunk.articleTitle, 'A/NoTitle')
})

test('accepts a Uint8Array view with a byte offset (worker-thread blobs)', () => {
  const padded = Buffer.from('XXXX<p>Offset ok</p>')
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 4, padded.byteLength - 4)
  const [chunk] = buildArticleChunks(view, { path: 'A/V', title: 'V' }, META, 'simple')
  assert.equal(chunk.text, 'Offset ok')
})
