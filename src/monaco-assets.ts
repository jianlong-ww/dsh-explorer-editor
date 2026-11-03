/**
 * Static carrier for the served Monaco build.
 *
 * Monaco is delivered as its own browser bundle rather than inlined into this
 * plugin's module-table entry: the editor plus its four workers are ~15 MB, and
 * the module table loads a plugin's client bundle eagerly for every session.
 * Serving the tree from the Host keeps `lib/client.js` small and lets the
 * browser cache chunks and workers after the first edit.
 *
 * The files live at `lib/monaco/vs` next to the Host bundle, and the browser's
 * AMD loader is pointed at `<prefix>/vs`, so every chunk, stylesheet, and
 * worker this build references resolves back through this handler.
 *
 * @module dsh-explorer-editor/monaco-assets
 */
import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/** Media type of each extension the build ships; anything else is served as bytes. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.html': 'text/html; charset=utf-8',
}

/** Extensions worth compressing on the wire. */
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.json', '.map', '.svg', '.ttf', '.html'])

/**
 * One cached build file: the bytes on disk and their compressed form, keyed by
 * the stat that produced them so a rebuilt bundle is re-read.
 */
interface CachedFile {
  readonly version: string
  readonly raw: Buffer
  readonly gzipped: Buffer
}

/** Read-through cache of served files, bounded by the size of one build. */
const cache = new Map<string, CachedFile>()

/**
 * The directory holding the published Monaco build.
 * @returns its absolute path, beside the running Host bundle.
 */
export function monacoRoot(): string {
  return fileURLToPath(new URL('./monaco', import.meta.url))
}

/**
 * Read and memoize one build file.
 * @param path - absolute file path.
 * @returns the cached entry, or undefined when the file is gone.
 */
function readCached(path: string): CachedFile | undefined {
  const info = statSync(path, { throwIfNoEntry: false })
  if (info?.isFile() !== true) return undefined
  const version = `${String(info.mtimeMs)}-${String(info.size)}`
  const hit = cache.get(path)
  if (hit !== undefined && hit.version === version) return hit
  const raw = readFileSync(path)
  const entry: CachedFile = { version, raw, gzipped: gzipSync(raw) }
  cache.set(path, entry)
  return entry
}

/**
 * Resolve one request path inside the build directory without escaping it.
 * @param root - the build directory.
 * @param relative - request path below it, always starting with `/`.
 * @returns the absolute file path, or undefined when it escapes the root.
 */
function inside(root: string, relative: string): string | undefined {
  const target = resolve(root, `.${relative}`)
  return target === root || target.startsWith(`${root}${sep}`) ? target : undefined
}

/**
 * Answer one Monaco asset request.
 *
 * Owns the whole response: a missing file is a 404, an unchanged ETag is a 304,
 * and a compressible file is sent gzipped when the browser asks for it.
 * @param req - the incoming request.
 * @param res - the response to own.
 * @param relative - request path below the build root, still URL-encoded.
 * @param root - override for the build directory; defaults to the published one.
 */
export function serveMonaco(
  req: IncomingMessage,
  res: ServerResponse,
  relative: string,
  root: string = monacoRoot(),
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (decoded.includes('\0')) {
    res.writeHead(400)
    res.end()
    return
  }
  const path = inside(root, decoded)
  const entry = path === undefined ? undefined : readCached(path)
  if (path === undefined || entry === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const extension = extname(path).toLowerCase()
  const etag = `"${entry.version}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    res.end()
    return
  }
  const acceptsGzip = String(req.headers['accept-encoding'] ?? '').includes('gzip')
  const compress = acceptsGzip && COMPRESSIBLE.has(extension)
  const body = compress ? entry.gzipped : entry.raw
  res.writeHead(200, {
    'content-type': MEDIA_TYPES[extension] ?? 'application/octet-stream',
    'content-length': String(body.byteLength),
    'cache-control': 'public, max-age=3600',
    etag,
    vary: 'accept-encoding',
    ...compress ? { 'content-encoding': 'gzip' } : {},
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}
