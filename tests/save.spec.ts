/**
 * Transport tests: the browser's save call folds every answer — the Host's
 * envelope, a bare status, and a dropped connection — into one outcome.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDeploymentFacts, postSave } from '../src/client/save.ts'
import { REQUEST_HEADER, SAVE_ROUTE } from '../src/protocol.ts'

/** Replace fetch with a scripted response. */
function stubFetch(answer: (url: string) => Promise<unknown> | unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return await answer(url)
  })
  return calls
}

/** A minimal Response. */
function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

const request = { sessionId: 's1', path: 'a.txt', text: 'after\n', expectedVersion: 'v1' }

afterEach(() => { vi.unstubAllGlobals() })

describe('postSave', () => {
  it('posts the request with the plugin header', async () => {
    const calls = stubFetch(() => response(200, { ok: true, value: { absolutePath: '/ws/a.txt', version: 'v2', bytes: 6 } }))
    const outcome = await postSave(request, new AbortController().signal)
    expect(outcome.ok).toBe(true)
    expect(calls[0]?.url).toBe(SAVE_ROUTE)
    expect((calls[0]?.init?.headers as Record<string, string>)[REQUEST_HEADER]).toBe('1')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(request)
  })

  it('passes the Host failure through with its code', async () => {
    stubFetch(() => response(409, { ok: false, error: { code: 'stale-version', message: 'changed', path: 'a.txt' } }))
    const outcome = await postSave(request, new AbortController().signal)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.failure.code).toBe('stale-version')
  })

  it('carries the limit and current version through', async () => {
    stubFetch(() => response(413, { ok: false, error: { code: 'too-large', message: 'cap', limit: 1024 } }))
    const tooLarge = await postSave(request, new AbortController().signal)
    expect(!tooLarge.ok && tooLarge.failure.limit).toBe(1024)
    stubFetch(() => response(409, { ok: false, error: { code: 'stale-version', message: 'changed', currentVersion: 'v9' } }))
    const stale = await postSave(request, new AbortController().signal)
    expect(!stale.ok && stale.failure.currentVersion).toBe('v9')
  })

  it('maps a bodyless status', async () => {
    stubFetch(() => ({ ok: false, status: 403, json: async () => { throw new Error('no body') } }))
    const outcome = await postSave(request, new AbortController().signal)
    expect(!outcome.ok && outcome.failure).toMatchObject({ code: 'denied', status: 403 })
  })

  it('reports a dropped connection as offline', async () => {
    stubFetch(() => { throw new Error('fetch failed') })
    const outcome = await postSave(request, new AbortController().signal)
    expect(!outcome.ok && outcome.failure.code).toBe('offline')
  })

  it('rethrows a cancellation instead of reporting a failure', async () => {
    const controller = new AbortController()
    stubFetch(() => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(postSave(request, controller.signal)).rejects.toThrow()
  })
})

describe('fetchDeploymentFacts', () => {
  it('reads the cap the Host reports', async () => {
    stubFetch(() => response(200, { ok: true, value: { maxWriteBytes: 4096, respectSessionMode: false } }))
    const facts = await fetchDeploymentFacts(new AbortController().signal)
    expect(facts).toEqual({ maxWriteBytes: 4096, respectSessionMode: false })
  })

  it('returns undefined when the route is not there', async () => {
    stubFetch(() => response(404, { ok: false, error: { code: 'bad-request', message: 'gone' } }))
    expect(await fetchDeploymentFacts(new AbortController().signal)).toBeUndefined()
  })

  it('returns undefined when the Host is unreachable', async () => {
    stubFetch(() => { throw new Error('fetch failed') })
    expect(await fetchDeploymentFacts(new AbortController().signal)).toBeUndefined()
  })
})
