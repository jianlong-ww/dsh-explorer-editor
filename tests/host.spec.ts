/**
 * Host route tests: the save endpoint against a fake Host, so every guard —
 * body shape, containment, symlink, sandbox mode, version CAS, write cap — is
 * pinned without a real filesystem.
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { REQUEST_HEADER, SAVE_ROUTE, STATE_ROUTE } from '../src/protocol.ts'

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => Promise<void>
}

/** A response that records what the handler wrote. */
class FakeResponse extends EventEmitter {
  status = 0
  readonly headers: Record<string, string> = {}
  private readonly chunks: string[] = []

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value)
    return this
  }

  end(text?: string): void {
    if (text !== undefined) this.chunks.push(text)
  }

  get json(): unknown {
    return JSON.parse(this.chunks.join(''))
  }
}

/** One request against the registered route. */
async function call(
  route: Route,
  init: { method?: string; url?: string; headers?: Record<string, string>; body?: string },
): Promise<FakeResponse> {
  const request = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body, 'utf8')])
  Object.assign(request, {
    method: init.method ?? 'POST',
    url: init.url ?? SAVE_ROUTE,
    headers: init.headers ?? { host: '127.0.0.1:59053', [REQUEST_HEADER]: '1' },
  })
  const response = new FakeResponse()
  await route.handler(request, response)
  return response
}

/** A body the route accepts. */
function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sessionId: 's1',
    path: 'notes.txt',
    text: 'hello\n',
    expectedVersion: 'v1',
    ...overrides,
  })
}

interface HostOptions {
  /** What `lstat` reports for the target; `null` means the target is missing. */
  entry?: { type: 'file' | 'directory' | 'symlink' } | null
  /** Whether the resolved target stays inside the workspace root. */
  contained?: boolean
  /** Sandbox mode the policy resolves to. */
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Live session cwd, or undefined for a cold session. */
  cwd?: string
  /** Persisted cwd for a cold session. */
  storedCwd?: string
  /** Failure `writeText` throws. */
  writeError?: { code: string; message: string }
}

/** Mount the plugin over a fake Host and return its route with the recorded calls. */
function mount(options: HostOptions = {}) {
  const routes: Route[] = []
  const writeText = vi.fn(async () => {
    if (options.writeError !== undefined) throw options.writeError
    return { version: 'v2' }
  })
  const emit = vi.fn()
  const resolvePolicy = vi.fn(() => ({ mode: options.mode ?? 'workspace-write', workspaceRoot: '/deploy' }))
  const ctx = {
    effect: (factory: () => unknown) => {
      const dispose = factory()
      return () => { void dispose }
    },
    webServer: {
      register: (route: Route) => { routes.push(route); return () => {} },
    },
    fs: {
      lstat: vi.fn(async () => (options.entry === null ? undefined : (options.entry ?? { type: 'file' as const }))),
      resolve: vi.fn(async (path: string) => `/ws/${path.replace(/^\/ws\//u, '')}`),
      contains: vi.fn(() => options.contained ?? true),
      writeText,
      processPath: vi.fn((target: string) => target),
    },
    sandboxPolicy: {
      workspaceRoot: '/deploy',
      resolve: resolvePolicy,
    },
    sessions: {
      get: vi.fn(() => (options.cwd === undefined ? undefined : { header: { cwd: options.cwd } })),
    },
    get: vi.fn((name: string) => name === 'sessionPersistence' && options.storedCwd !== undefined
      ? { stat: async () => ({ header: { cwd: options.storedCwd } }) }
      : undefined),
    emit,
  }
  apply(ctx as never, {})
  const route = routes[0]
  if (route === undefined) throw new Error('the plugin registered no route')
  return { route, writeText, emit, resolvePolicy, ctx }
}

describe('host save route', () => {
  it('registers one prefix route under the plugin prefix', () => {
    const { route } = mount()
    expect(route.kind).toBe('prefix')
    expect(route.path).toBe('/explorer-editor')
  })

  it('rejects a request without the plugin header', async () => {
    const { route } = mount()
    const response = await call(route, { headers: { host: '127.0.0.1:59053' }, body: body() })
    expect(response.status).toBe(403)
  })

  it('rejects a cross-origin request', async () => {
    const { route } = mount()
    const response = await call(route, {
      headers: { host: '127.0.0.1:59053', [REQUEST_HEADER]: '1', origin: 'http://evil.test' },
      body: body(),
    })
    expect(response.status).toBe(403)
  })

  it('answers an unknown path with 404', async () => {
    const { route } = mount()
    const response = await call(route, { url: '/explorer-editor/api/other', body: body() })
    expect(response.status).toBe(404)
  })

  it('answers GET on the save path with 405', async () => {
    const { route } = mount()
    const response = await call(route, { method: 'GET', body: undefined })
    expect(response.status).toBe(405)
    expect(response.headers.allow).toBe('POST')
  })

  it('serves deployment facts on the state path', async () => {
    const { route } = mount()
    const response = await call(route, { method: 'GET', url: STATE_ROUTE, body: undefined })
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ ok: true, value: { maxWriteBytes: 2 * 1024 * 1024, respectSessionMode: true } })
  })

  it('writes under the workspace with the client version, then reports it', async () => {
    const { route, writeText, emit } = mount()
    const response = await call(route, { body: body() })
    expect(response.status).toBe(200)
    expect(response.json).toEqual({ ok: true, value: { absolutePath: '/ws/notes.txt', version: 'v2', bytes: 6 } })
    expect(writeText).toHaveBeenCalledTimes(1)
    const [target, text, intent, , policy] = writeText.mock.calls[0] as unknown as [string, string, { kind: string; version: string }, AbortSignal, { mode: string; workspaceRoot: string }]
    expect(target).toBe('/ws/notes.txt')
    expect(text).toBe('hello\n')
    expect(intent).toEqual({ kind: 'replaceIfVersion', version: 'v1' })
    expect(policy.mode).toBe('workspace-write')
    expect(emit).toHaveBeenCalledWith('fs/observed', '/ws/notes.txt', { kind: 'present', version: 'v2' }, undefined)
  })

  it('refuses a body that is not JSON', async () => {
    const { route } = mount()
    const response = await call(route, { body: '{not json' })
    expect(response.status).toBe(400)
    expect((response.json as { error: { code: string } }).error.code).toBe('bad-request')
  })

  it('refuses a body without a path', async () => {
    const { route } = mount()
    const response = await call(route, { body: body({ path: '' }) })
    expect(response.status).toBe(400)
  })

  it('refuses text above the write cap without writing', async () => {
    const { route, writeText } = mount()
    // Just over the cap but under the body limit, so the save itself refuses it.
    const response = await call(route, { body: body({ text: 'x'.repeat(2 * 1024 * 1024 + 10) }) })
    expect(response.status).toBe(413)
    expect((response.json as { error: { code: string; limit: number } }).error).toMatchObject({ code: 'too-large', limit: 2 * 1024 * 1024 })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('reports a missing file as not-found', async () => {
    const { route } = mount({ entry: null })
    const response = await call(route, { body: body() })
    expect(response.status).toBe(404)
    expect((response.json as { error: { code: string } }).error.code).toBe('not-found')
  })

  it('refuses a directory target', async () => {
    const { route, writeText } = mount({ entry: { type: 'directory' } })
    const response = await call(route, { body: body() })
    expect(response.status).toBe(400)
    expect((response.json as { error: { code: string } }).error.code).toBe('not-regular-file')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('refuses a target outside the workspace', async () => {
    const { route, writeText } = mount({ contained: false })
    const response = await call(route, { body: body({ path: '../escape.txt' }) })
    expect(response.status).toBe(403)
    expect((response.json as { error: { code: string } }).error.code).toBe('outside-workspace')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('maps a stale version to 409 without overwriting', async () => {
    const { route } = mount({ writeError: { code: 'FS_STALE_VERSION', message: 'file changed since it was read' } })
    const response = await call(route, { body: body() })
    expect(response.status).toBe(409)
    expect((response.json as { error: { code: string } }).error.code).toBe('stale-version')
  })

  it('maps a sandbox denial to 403 with the mode', async () => {
    const { route } = mount({ mode: 'read-only', writeError: { code: 'FS_SANDBOX_DENIED', message: 'denied' } })
    const response = await call(route, { body: body() })
    expect(response.status).toBe(403)
    expect((response.json as { error: { code: string; mode: string } }).error).toMatchObject({ code: 'denied', mode: 'read-only' })
  })

  it('maps an unknown filesystem failure to io-error', async () => {
    const { route } = mount({ writeError: { code: 'FS_IO_ERROR', message: 'disk on fire' } })
    const response = await call(route, { body: body() })
    expect(response.status).toBe(400)
    expect((response.json as { error: { code: string } }).error.code).toBe('io-error')
  })

  it('resolves a cold session through its persisted header', async () => {
    const { route, writeText } = mount({ storedCwd: '/cold/workspace' })
    const response = await call(route, { body: body() })
    expect(response.status, JSON.stringify(response.json)).toBe(200)
    const [, , , , policy] = writeText.mock.calls[0] as unknown as [string, string, unknown, AbortSignal, { workspaceRoot: string }]
    // The sandbox policy's own root would be the deployment root here; the
    // workspace the browser named must win or `workspace-write` denies it.
    expect(policy.workspaceRoot).toBe('/cold/workspace')
  })

  it('uses the live session cwd when one exists', async () => {
    const { route, writeText } = mount({ cwd: '/live/workspace' })
    await call(route, { body: body() })
    const [, , , , policy] = writeText.mock.calls[0] as unknown as [string, string, unknown, AbortSignal, { workspaceRoot: string }]
    expect(policy.workspaceRoot).toBe('/live/workspace')
  })
})
