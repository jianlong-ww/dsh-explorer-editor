/**
 * Parse the resource address a document tab carries.
 *
 * A file tab's `contentId` — passed to the document body as `resourceAddress` —
 * is a `dsh-resource://` address in one of two shapes:
 *
 * - `dsh-resource://file/session/<sessionId>/<workspacePath>`
 * - `dsh-resource://file/absolute/<absolutePath>`
 *
 * The body needs the path for the editor and for the save call, and the session
 * for the workspace Remote and the save policy. The framework already hands the
 * component a `sessionId`, so this only has to recover the path, preferring the
 * address's own session when it carries one.
 *
 * @module dsh-explorer-editor/client/address
 */

/** What a file address says about its target. */
export interface FileAddress {
  /** Session named by a `session` address; undefined for an `absolute` one. */
  readonly sessionId: string | undefined
  /** Path as the address carries it: workspace-relative or absolute. */
  readonly path: string
}

/**
 * Decode one file resource address.
 * @param address - the tab's `contentId` / `resourceAddress`.
 * @returns the session and path, or undefined when the address is not a file address.
 */
export function parseFileAddress(address: string): FileAddress | undefined {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return undefined
  }
  if (url.hostname !== 'file') return undefined
  const segments = url.pathname.split('/').filter(segment => segment.length > 0)
  const [form, ...rest] = segments
  if (form === 'session') {
    const [sessionId, ...path] = rest
    if (sessionId === undefined || path.length === 0) return undefined
    return { sessionId, path: path.map(decodeURIComponent).join('/') }
  }
  if (form === 'absolute') {
    if (rest.length === 0) return undefined
    // An absolute Windows path arrives as `C:/dir/file.ts`: the drive letter is
    // the first segment, so the path is rejoined rather than treated as relative.
    return { sessionId: undefined, path: rest.map(decodeURIComponent).join('/') }
  }
  return undefined
}

/** Suffix to Monaco language id, for the formats this editor claims. */
const LANGUAGE_BY_SUFFIX: Readonly<Record<string, string>> = {
  // TypeScript / JavaScript
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  // Systems and application languages
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php', cs: 'csharp', swift: 'swift',
  c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  m: 'objective-c', mm: 'objective-c',
  // Markup and data
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', xml: 'xml',
  graphql: 'graphql', gql: 'graphql',
  // Prose
  md: 'markdown', markdown: 'markdown', mdx: 'mdx', rst: 'restructuredtext',
  // Configuration and scripts
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini',
  env: 'ini', properties: 'ini',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  sql: 'sql',
}

/**
 * The Monaco language id for a path's suffix.
 * @param path - file path as carried by the address.
 * @returns the language id Monaco registers, defaulting to plain text.
 */
export function languageOf(path: string): string {
  const name = path.toLowerCase()
  const suffix = name.slice(name.lastIndexOf('.') + 1)
  return LANGUAGE_BY_SUFFIX[suffix] ?? 'plaintext'
}
