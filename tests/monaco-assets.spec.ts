/**
 * Monaco asset carrier tests: the browser pulls ~15 MB of build files through
 * this handler, so caching, compression, and containment are worth pinning.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { serveMonaco } from '../src/monaco-assets.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-monaco-'))
mkdirSync(join(root, 'vs', 'editor'), { recursive: true })
writeFileSync(join(root, 'vs', 'editor', 'editor.main.js'), 'console.log("monaco")\n')
writeFileSync(join(root, 'vs', 'editor', 'editor.main.css'), 'body{color:red}\n')
writeFileSync(join(root, 'vs', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** A response that records what the carrier wrote. */
function harness(method: string, headers: Record<string, string> = {}) {
  const chunks: Buffer[] = []
  const written: Record<string, string> = {}
  const res = {
    status: 0,
    headers: written,
    writeHead(status: number, fields?: Record<string, string>) {
      this.status = status
      Object.assign(written, fields ?? {})
      return this
    },
    end(body?: Buffer | string) {
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body))
    },
  }
  const req = { method, headers }
  return {
    res,
    call: (path: string) => {
      serveMonaco(req as never, res as never, path, root)
      return { status: res.status, headers: written, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }
    },
  }
}

describe('serveMonaco', () => {
  it('serves a build chunk with its media type', () => {
    const outcome = harness('GET').call('/vs/editor/editor.main.js')
    expect(outcome.status).toBe(200)
    expect(outcome.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(outcome.text).toContain('console.log("monaco")')
  })

  it('compresses a chunk when the browser accepts gzip', () => {
    const outcome = harness('GET', { 'accept-encoding': 'gzip' }).call('/vs/editor/editor.main.js')
    expect(outcome.status).toBe(200)
    expect(outcome.headers['content-encoding']).toBe('gzip')
  })

  it('does not compress an image', () => {
    const outcome = harness('GET', { 'accept-encoding': 'gzip' }).call('/vs/logo.png')
    expect(outcome.status).toBe(200)
    expect(outcome.headers['content-encoding']).toBeUndefined()
    expect(outcome.headers['content-type']).toBe('image/png')
  })

  it('answers an unchanged ETag with 304', () => {
    const first = harness('GET').call('/vs/editor/editor.main.js')
    const second = harness('GET', { 'if-none-match': first.headers.etag ?? '' }).call('/vs/editor/editor.main.js')
    expect(second.status).toBe(304)
  })

  it('refuses a traversal attempt', () => {
    expect(harness('GET').call('/vs/../../package.json').status).toBe(404)
  })

  it('answers an unknown file with 404', () => {
    expect(harness('GET').call('/vs/nope.js').status).toBe(404)
  })

  it('answers a non-GET method with 405', () => {
    expect(harness('POST').call('/vs/editor/editor.main.js').status).toBe(405)
  })
})
