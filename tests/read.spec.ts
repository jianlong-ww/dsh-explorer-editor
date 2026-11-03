/**
 * Reading tests: the byte-level guarantees the editor depends on — exact bytes,
 * the BOM kept, non-UTF-8 and NUL refused — plus the Host failure mapping.
 */
import { describe, expect, it } from 'vitest'
import { readEditableFile } from '../src/client/read.ts'

/** A client context whose file namespace answers with one payload. */
function contextWith(answer: unknown) {
  return {
    remote: {
      workspaceFiles: {
        readBytes: async () => answer,
      },
    },
  } as never
}

/** A successful Host answer carrying the given bytes. */
function bytes(data: Uint8Array) {
  return { ok: true, value: { data, version: 'v1', absolutePath: '/ws/a.txt', offset: 0, eof: true } }
}

const encoder = new TextEncoder()

describe('readEditableFile', () => {
  it('returns the text with the version it was read at', async () => {
    const ctx = contextWith(bytes(encoder.encode('line\n')))
    const outcome = await readEditableFile(ctx, 's1', 'a.txt', new AbortController().signal)
    expect(outcome).toEqual({ ok: true, value: { text: 'line\n', version: 'v1', bytes: 5 } })
  })

  it('keeps the trailing newline byte-for-byte', async () => {
    const ctx = contextWith(bytes(encoder.encode('a\nb\n')))
    const outcome = await readEditableFile(ctx, 's1', 'a.txt', new AbortController().signal)
    expect(outcome.ok && outcome.value.text.endsWith('\n')).toBe(true)
  })

  it('keeps a byte-order mark in the text', async () => {
    const ctx = contextWith(bytes(encoder.encode('\uFEFFhello')))
    const outcome = await readEditableFile(ctx, 's1', 'a.txt', new AbortController().signal)
    expect(outcome.ok && outcome.value.text.startsWith('\uFEFF')).toBe(true)
  })

  it('refuses invalid UTF-8', async () => {
    const ctx = contextWith(bytes(new Uint8Array([0x61, 0xff, 0x62])))
    const outcome = await readEditableFile(ctx, 's1', 'a.bin', new AbortController().signal)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.failure.code).toBe('not-text')
  })

  it('refuses NUL bytes as binary', async () => {
    const ctx = contextWith(bytes(new Uint8Array([0x61, 0x00, 0x62])))
    const outcome = await readEditableFile(ctx, 's1', 'a.bin', new AbortController().signal)
    expect(!outcome.ok && outcome.failure.code).toBe('binary')
  })

  it('maps the Host caps and kinds onto editor failures', async () => {
    const cases = [
      ['workspace-file/too-large', 'too-large'],
      ['workspace-file/not-text', 'not-text'],
      ['workspace-file/not-found', 'not-found'],
      ['workspace-file/not-regular-file', 'not-regular-file'],
      ['workspace-file/outside-workspace', 'read-failed'],
    ] as const
    for (const [code, expected] of cases) {
      const ctx = contextWith({ ok: false, error: { code, message: 'host said no' } })
      const outcome = await readEditableFile(ctx, 's1', 'a.txt', new AbortController().signal)
      expect(!outcome.ok && outcome.failure.code).toBe(expected)
    }
  })

  it('reports a thrown carrier failure as read-failed', async () => {
    const ctx = {
      remote: {
        workspaceFiles: {
          readBytes: async () => { throw new Error('connection closed') },
        },
      },
    } as never
    const outcome = await readEditableFile(ctx, 's1', 'a.txt', new AbortController().signal)
    expect(!outcome.ok && outcome.failure.code).toBe('read-failed')
  })
})
