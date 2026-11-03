/**
 * Host half: the workspace file save endpoint.
 *
 * The browser never writes the filesystem directly. It posts one complete
 * replacement here, and this plugin is the only code path that decides whether
 * the write may happen:
 *
 * 1. the body is bounded, parsed, and shape-checked;
 * 2. the target must resolve inside the Session's workspace root;
 * 3. the target itself must already be a regular file — a final symlink is
 *    refused, so a save cannot be redirected out of the workspace;
 * 4. the Session's sandbox policy (`read-only` / `workspace-write` /
 *    `danger-full-access`) decides, exactly as it does for an agent write;
 * 5. the write is a version-guarded replacement, so a file that changed since
 *    the browser read it is refused instead of silently clobbered.
 *
 * Unlike `workspaceFiles`, which is read-only by contract, this service may
 * mutate the workspace; unlike an agent tool, it is not part of the model's
 * tool history, so it emits `fs/observed` with no actor and produces no
 * `tool/call` records.
 *
 * @module dsh-explorer-editor
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  MONACO_PREFIX,
  REQUEST_HEADER,
  SAVE_ROUTE,
  STATE_ROUTE,
  TYPES_ROUTE,
  type SaveFailure,
  type SaveFailureCode,
  type SaveRequest,
  type SaveResponse,
  type SaveValue,
  type StateValue,
  type TypePayload,
} from './protocol.ts'
import { serveMonaco } from './monaco-assets.ts'
import { collectTypes } from './type-resolver.ts'

/** Cordis plugin name. */
export const name = 'dsh-explorer-editor'

/** Services the plugin needs: the HTTP carrier, the filesystem, its policy, and Session headers. */
export const inject = ['webServer', 'fs', 'sandboxPolicy', 'sessions']

/** Deployment limits for one save. */
export interface Config {
  /** Inclusive UTF-8 byte cap on one save's text; a larger body is refused, never truncated. */
  readonly maxWriteBytes: number
  /** Use the Session's sandbox mode; when false, the deployment default applies to every save. */
  readonly respectSessionMode: boolean
}

/** Defaults applied when the composition layer omits a field. */
const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024

/**
 * Resolve one raw config value into deployment limits.
 *
 * Cordis validates a plugin's exported `Config` through the Standard Schema
 * interface (`Config['~standard'].validate`) and hands the result to `apply`.
 * Implementing that interface directly — instead of importing a schema library
 * — keeps this Host bundle free of runtime imports: inside a shipped DSH runtime
 * a bare `@deepseek-ai/*` specifier has to resolve from the plugin's own
 * directory, and a schema library is one dependency that is simply not there.
 * @param value - raw config from `cordis.patch.yml`.
 * @returns the limits, with invalid or missing fields defaulted.
 */
export function resolveConfig(value: unknown): Config {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const maxWriteBytes = record.maxWriteBytes
  const respectSessionMode = record.respectSessionMode
  return {
    maxWriteBytes: typeof maxWriteBytes === 'number' && Number.isSafeInteger(maxWriteBytes) && maxWriteBytes > 0
      ? maxWriteBytes
      : DEFAULT_MAX_WRITE_BYTES,
    respectSessionMode: typeof respectSessionMode === 'boolean' ? respectSessionMode : true,
  }
}

/** Config schema the Loader validates `cordis.patch.yml` against. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-explorer-editor',
    /**
     * Validate one config object.
     * @param value - raw config from the composition layer.
     * @returns the resolved limits; never reports issues, because every field has a default.
     */
    validate(value: unknown): { readonly value: Config } {
      return { value: resolveConfig(value) }
    },
  },
}

/** JSON request bodies carry the text plus a small envelope; this is the slack over the text cap. */
const BODY_OVERHEAD_BYTES = 64 * 1024

/** The byte text never carries: its presence in a path marks an unusable request. */
const NUL = String.fromCharCode(0)

/** A refusal the route can answer with a status and a code. */
class Refusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 405 | 409 | 413 | 415 | 500,
    readonly failure: SaveFailure,
  ) {
    super(failure.message)
    this.name = 'ExplorerEditorRefusal'
  }
}

/**
 * The code a filesystem failure carries. The error class belongs to whichever
 * `dsh-fs` instance the provider loaded, so only the code crosses this boundary.
 * @param error - anything thrown by the filesystem.
 * @returns the `FS_*` code, or undefined for an unrelated failure.
 */
function fsCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Map one filesystem failure onto the wire contract.
 * @param error - the thrown value.
 * @param request - the save being attempted, for path reporting.
 * @param mode - the sandbox mode in force, reported with a denial.
 * @returns the failure the browser renders.
 */
function classify(error: unknown, request: SaveRequest, mode: string): SaveFailure {
  const code = fsCode(error)
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'FS_STALE_VERSION':
      return { code: 'stale-version', message, path: request.path }
    case 'FS_SANDBOX_DENIED':
      return { code: 'denied', message, path: request.path, mode: sandboxModeName(mode) }
    case 'FS_NOT_FOUND':
      return { code: 'not-found', message, path: request.path }
    case 'FS_NOT_REGULAR_FILE':
      return { code: 'not-regular-file', message, path: request.path }
    case 'FS_TOO_LARGE':
      return { code: 'too-large', message, path: request.path }
    default:
      return { code: 'io-error', message, path: request.path }
  }
}

/**
 * Narrow an arbitrary policy mode string to the three names the contract publishes.
 * @param mode - the policy's mode field.
 * @returns the published name, defaulting to `workspace-write`.
 */
function sandboxModeName(mode: string): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (mode === 'read-only' || mode === 'danger-full-access') return mode
  return 'workspace-write'
}

/**
 * Read a bounded request body as text.
 * @param req - the incoming request.
 * @param limit - inclusive byte cap.
 * @returns the decoded body.
 * @throws Refusal with 413 when the cap is exceeded, 400 when it is not UTF-8.
 */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > limit) {
    throw new Refusal(413, { code: 'too-large', message: `request body exceeds ${String(limit)} bytes`, limit })
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > limit) {
      throw new Refusal(413, { code: 'too-large', message: `request body exceeds ${String(limit)} bytes`, limit })
    }
    chunks.push(bytes)
  }
  try {
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    throw new Refusal(400, { code: 'bad-request', message: 'request body is not UTF-8' })
  }
}

/**
 * Parse and validate one save request.
 * @param body - the raw JSON body.
 * @returns the validated request.
 * @throws Refusal with 400 when a field is missing or unusable.
 */
function parseSaveRequest(body: string): SaveRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    throw new Refusal(400, { code: 'bad-request', message: 'request body is not JSON' })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Refusal(400, { code: 'bad-request', message: 'request body must be an object' })
  }
  const fields = parsed as Record<string, unknown>
  const sessionId = fields.sessionId
  const path = fields.path
  const text = fields.text
  const expectedVersion = fields.expectedVersion
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Refusal(400, { code: 'bad-request', message: 'sessionId is required' })
  }
  if (typeof path !== 'string' || path.length === 0) {
    throw new Refusal(400, { code: 'bad-request', message: 'path is required' })
  }
  if (path.includes(NUL)) {
    throw new Refusal(400, { code: 'bad-request', message: 'path must not contain NUL', path })
  }
  if (typeof text !== 'string') {
    throw new Refusal(400, { code: 'bad-request', message: 'text is required', path })
  }
  if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
    throw new Refusal(400, { code: 'bad-request', message: 'expectedVersion is required', path })
  }
  return { sessionId, path, text, expectedVersion }
}

/**
 * Decide whether a request may reach the route at all.
 *
 * The check is same-origin: the browser's `Origin`, when it sends one, must
 * equal the origin of the request itself, and the custom header must be
 * present so a plain cross-site form submission cannot qualify.
 * @param req - the incoming request.
 * @returns whether the request is a same-origin call from the editor.
 */
function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers[REQUEST_HEADER] !== '1') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

/**
 * Resolve the workspace root and live Session for one save.
 *
 * A cold Session has no live object; its persisted header still names the cwd,
 * and without either the deployment's policy root is the only bound available.
 * @param ctx - Host context carrying Sessions and their persistence.
 * @param sessionId - the Session named by the browser.
 * @returns the workspace root the path resolves against, and the live Session when it exists.
 */
async function resolveScope(
  ctx: Context,
  sessionId: string,
): Promise<{ workspaceRoot: string; session: ReturnType<Context['sessions']['get']> }> {
  const session = ctx.sessions.get(sessionId as Parameters<Context['sessions']['get']>[0])
  if (session?.header.cwd !== undefined) return { workspaceRoot: session.header.cwd, session }
  // A cold Session has no live object, but its persisted header still names the
  // cwd; without either, the deployment's policy root is the only bound left.
  const stored = await ctx.get('sessionPersistence')?.stat(sessionId as never)
  if (stored?.header.cwd !== undefined) return { workspaceRoot: stored.header.cwd, session }
  return { workspaceRoot: ctx.sandboxPolicy.workspaceRoot, session }
}

/**
 * Perform one save.
 * @param ctx - Host context.
 * @param config - deployment limits.
 * @param request - the validated call.
 * @param signal - aborted when the browser disconnects.
 * @returns the written file's identity and new version.
 * @throws Refusal for every refusal the browser can act on.
 */
async function save(
  ctx: Context,
  config: Config,
  request: SaveRequest,
  signal: AbortSignal,
): Promise<SaveValue> {
  const bytes = Buffer.byteLength(request.text, 'utf8')
  if (bytes > config.maxWriteBytes) {
    throw new Refusal(413, {
      code: 'too-large',
      message: `"${request.path}" exceeds the ${String(config.maxWriteBytes)} byte write cap`,
      path: request.path,
      limit: config.maxWriteBytes,
    })
  }
  const { workspaceRoot, session } = await resolveScope(ctx, request.sessionId)
  const resolved = ctx.sandboxPolicy.resolve(
    config.respectSessionMode && session !== undefined ? { session } : {},
  )
  // The policy's own root comes from the live Session header or the deployment
  // default. A cold Session has no live header, so the deployment root would
  // replace the real workspace and `workspace-write` would deny the very file
  // the browser is allowed to save. Pin the policy to the scope resolved above.
  const policy = { ...resolved, workspaceRoot }
  const mode = policy.mode
  try {
    // Gate on the path itself before anything follows it: a final symlink must
    // not redirect a save outside the workspace.
    const entry = await ctx.fs.lstat(request.path, { cwd: workspaceRoot }, signal)
    if (entry === undefined) {
      throw new Refusal(404, { code: 'not-found', message: `no entry at "${request.path}"`, path: request.path })
    }
    if (entry.type !== 'file') {
      throw new Refusal(400, {
        code: 'not-regular-file',
        message: `"${request.path}" is a ${entry.type}`,
        path: request.path,
      })
    }
    const root = await ctx.fs.resolve(workspaceRoot, { signal })
    const target = await ctx.fs.resolve(request.path, { cwd: workspaceRoot, signal })
    if (!ctx.fs.contains(root, target)) {
      throw new Refusal(403, {
        code: 'outside-workspace',
        message: `"${request.path}" is outside the workspace`,
        path: request.path,
      })
    }
    const outcome = await ctx.fs.writeText(
      target,
      request.text,
      // The client sends the opaque version it read; the brand exists only in
      // the type system, so the cast is the whole conversion.
      { kind: 'replaceIfVersion', version: request.expectedVersion as unknown as FsVersion },
      signal,
      policy,
    )
    // No actor: this is a human edit, so the observation refreshes previews
    // through the change feed without recording that an agent read the file.
    ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, undefined)
    return {
      absolutePath: ctx.fs.processPath(target),
      version: outcome.version,
      bytes,
    }
  } catch (error: unknown) {
    if (error instanceof Refusal) throw error
    const failure = classify(error, request, mode)
    switch (failure.code) {
      case 'stale-version':
        throw new Refusal(409, failure)
      case 'denied':
        throw new Refusal(403, failure)
      case 'not-found':
        throw new Refusal(404, failure)
      case 'too-large':
        throw new Refusal(413, failure)
      default:
        throw new Refusal(400, failure)
    }
  }
}

/**
 * Write one JSON answer.
 * @param res - the response to own.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 */
function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
  })
  res.end(text)
}

/** The answer for a request that never reached the save path. */
function refuse(code: SaveFailureCode, message: string): SaveResponse {
  return { ok: false, error: { code, message } }
}

/** One request's shared cancellation, aborted when the browser disconnects. */
function requestSignal(res: ServerResponse): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  res.on('close', abort)
  return { signal: controller.signal, release: () => { res.off('close', abort) } }
}

/**
 * Collect the project types for one file, confined to its Session's workspace.
 * @param ctx - Host context carrying the filesystem and Session headers.
 * @param request - parsed request path and Session id.
 * @param signal - aborted when the browser disconnects.
 * @returns the payload Monaco's worker receives.
 * @throws Refusal when the target is outside the workspace or cannot be read.
 */
async function types(
  ctx: Context,
  request: { path: string; sessionId: string },
  signal: AbortSignal,
): Promise<TypePayload> {
  const { workspaceRoot } = await resolveScope(ctx, request.sessionId)
  const root = await ctx.fs.resolve(workspaceRoot, { signal })
  const target = await ctx.fs.resolve(request.path, { cwd: workspaceRoot, signal })
  if (!ctx.fs.contains(root, target)) {
    throw new Refusal(403, {
      code: 'outside-workspace',
      message: `"${request.path}" is outside the workspace`,
      path: request.path,
    })
  }
  try {
    return collectTypes(ctx.fs.processPath(target))
  } catch (error: unknown) {
    throw new Refusal(500, {
      code: 'io-error',
      message: error instanceof Error ? error.message : String(error),
      path: request.path,
    })
  }
}

/**
 * Plugin body: serve the save endpoint, the deployment facts, the project
 * types, and the Monaco build for every Session on this Host.
 * @param ctx - Host context.
 * @param config - deployment limits from the composition layer.
 */
export function apply(ctx: Context, config: Config | Partial<Config> = {}): void {
  // The Loader validates through `Config` before calling this; resolving again
  // costs nothing and keeps the plugin usable from a runtime that passes the
  // raw composition-layer value straight through.
  const resolved = resolveConfig(config)
  const bodyLimit = resolved.maxWriteBytes + BODY_OVERHEAD_BYTES
  const prefix = SAVE_ROUTE.slice(0, SAVE_ROUTE.indexOf('/api/'))
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = req.method ?? 'GET'
      if (url.pathname.startsWith(`${MONACO_PREFIX}/`)) {
        serveMonaco(req, res, url.pathname.slice(MONACO_PREFIX.length))
        return
      }
      if (url.pathname === STATE_ROUTE) {
        if (!sameOrigin(req)) {
          reply(res, 403, refuse('bad-request', 'same-origin request required'))
          return
        }
        if (method !== 'GET' && method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD')
          reply(res, 405, refuse('bad-request', 'GET required'))
          return
        }
        const value: StateValue = {
          maxWriteBytes: resolved.maxWriteBytes,
          respectSessionMode: resolved.respectSessionMode,
        }
        reply(res, 200, { ok: true, value })
        return
      }
      if (url.pathname === TYPES_ROUTE) {
        if (!sameOrigin(req)) {
          reply(res, 403, refuse('bad-request', 'same-origin request required'))
          return
        }
        if (method !== 'GET') {
          res.setHeader('allow', 'GET')
          reply(res, 405, refuse('bad-request', 'GET required'))
          return
        }
        const path = url.searchParams.get('path')
        const sessionId = url.searchParams.get('sessionId')
        if (path === null || path.length === 0 || sessionId === null || sessionId.length === 0) {
          reply(res, 400, refuse('bad-request', 'path and sessionId are required'))
          return
        }
        const { signal, release } = requestSignal(res)
        try {
          reply(res, 200, { ok: true, value: await types(ctx, { path, sessionId }, signal) })
        } catch (error: unknown) {
          if (error instanceof Refusal) reply(res, error.status, { ok: false, error: error.failure })
          else reply(res, 500, refuse('io-error', error instanceof Error ? error.message : String(error)))
        } finally {
          release()
        }
        return
      }
      if (url.pathname !== SAVE_ROUTE) {
        reply(res, 404, refuse('bad-request', 'unknown endpoint'))
        return
      }
      if (!sameOrigin(req)) {
        reply(res, 403, refuse('bad-request', 'same-origin request required'))
        return
      }
      if (method !== 'POST') {
        res.setHeader('allow', 'POST')
        reply(res, 405, refuse('bad-request', 'POST required'))
        return
      }
      const { signal, release } = requestSignal(res)
      try {
        const request = parseSaveRequest(await readBody(req, bodyLimit))
        const value = await save(ctx, resolved, request, signal)
        reply(res, 200, { ok: true, value })
      } catch (error: unknown) {
        if (error instanceof Refusal) {
          reply(res, error.status, { ok: false, error: error.failure })
        } else {
          const message = error instanceof Error ? error.message : String(error)
          reply(res, 500, refuse('io-error', message))
        }
      } finally {
        release()
      }
    },
  }), 'explorer editor: save route')
}
