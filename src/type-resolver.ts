/**
 * Collect the project types Monaco's TypeScript worker needs for one file.
 *
 * Monaco's worker compiles in a sandbox: it sees the models the page created
 * and the ambient libraries the page added, and nothing else. Left alone it can
 * complete local symbols, but not a library's API — `<div ` would suggest
 * nothing and `useState` would have no signature, because `@types/react` never
 * reached the compiler.
 *
 * This module closes that gap on the Host, where the workspace is readable:
 *
 * 1. find the nearest `tsconfig.json` and lift its `compilerOptions`;
 * 2. resolve every module the open file imports — relative files and packages,
 *    including the `@types/<name>` fallback a plain-JS dependency needs;
 * 3. follow those declaration files' own imports, so a package's transitive
 *    `.d.ts` closure arrives too (React pulls `csstype`, `prop-types`, …).
 *
 * The walk is bounded: a declaration closure is a library surface, not a
 * project graph, and the browser pays for every byte over the wire.
 *
 * @module dsh-explorer-editor/type-resolver
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { TypeLibrary, TypePayload } from './protocol.ts'

/** Ceiling on declaration files one payload may carry. */
const MAX_LIBRARIES = 250

/**
 * How many declaration hops away from the edited file the closure may reach.
 *
 * Direct imports are depth 1. React's own typings are depth 1 and what they
 * import (csstype, prop-types) is depth 2, so three covers a library's public
 * surface; deeper is transitive implementation nobody completes against, and it
 * is what turns a payload into the whole repository.
 */
const MAX_DEPTH = 3

/** Ceiling on declaration bytes one payload may carry. */
const MAX_BYTES = 6 * 1024 * 1024

/** Bytes of a source file scanned for imports; beyond this, imports are missed rather than read. */
const MAX_SCAN_BYTES = 512 * 1024

/** Extension candidates for a relative import, most specific first. */
const FILE_SUFFIXES = ['', '.d.ts', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'] as const

/** Suffixes Monaco's TypeScript worker understands as an extra library. */
const DECLARATION = /\.d\.[cm]?ts$/u

/** `import … from 'x'`, `import 'x'`, `import('x')`, and `require('x')`. */
const SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /\bimport\s+['"]([^'"]+)['"]/gu,
] as const

/** `/// <reference path="…" />` and `/// <reference types="…" />`. */
const REFERENCES = /\/\/\/\s*<reference\s+(?:path|types)\s*=\s*['"]([^'"]+)['"]/gu

/**
 * Read a JSON file that may carry comments and trailing commas, as tsconfig does.
 * @param text - file contents.
 * @returns the parsed value, or undefined when it is not JSON-like after cleanup.
 */
function parseJsonc(text: string): unknown {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '"') {
      // Copy the whole string literal, escapes included, so `//` inside it survives.
      let end = index + 1
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue }
        if (text[end] === '"') { end += 1; break }
        end += 1
      }
      out += text.slice(index, end)
      index = end
      continue
    }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
      continue
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }
    out += char
    index += 1
  }
  const stripped = out.replace(/,(\s*[}\]])/gu, '$1')
  try {
    return JSON.parse(stripped) as unknown
  } catch {
    return undefined
  }
}

/**
 * Find the nearest `tsconfig.json` above a directory.
 * @param start - directory to search from.
 * @param depth - how many levels up to try.
 * @returns the absolute config path, or undefined.
 */
function findTsconfig(start: string, depth = 8): string | undefined {
  let directory = start
  for (let step = 0; step < depth; step += 1) {
    const candidate = join(directory, 'tsconfig.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/** Compiler options that change how completion resolves, in tsconfig spelling. */
const OPTION_KEYS = [
  'target', 'module', 'moduleResolution', 'jsx', 'strict', 'noImplicitAny', 'strictNullChecks',
  'esModuleInterop', 'allowSyntheticDefaultImports', 'allowJs', 'checkJs', 'resolveJsonModule',
  'isolatedModules', 'baseUrl', 'rootDir', 'lib', 'types', 'skipLibCheck',
] as const

/**
 * Lift the options the editor cares about out of one tsconfig chain.
 * @param path - absolute tsconfig path.
 * @returns the reduced `compilerOptions`, plus any `extends` config's options beneath its own.
 */
function readCompilerOptions(path: string): Record<string, string | number | boolean | readonly string[]> {
  const parsed = parseJsonc(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return {}
  const config = parsed as { extends?: unknown; compilerOptions?: unknown }
  const inherited = typeof config.extends === 'string' && !config.extends.startsWith('@')
    ? readCompilerOptions(resolve(dirname(path), config.extends))
    : {}
  const own: Record<string, string | number | boolean | readonly string[]> = {}
  if (typeof config.compilerOptions === 'object' && config.compilerOptions !== null) {
    const source = config.compilerOptions as Record<string, unknown>
    for (const key of OPTION_KEYS) {
      const value = source[key]
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') own[key] = value
      else if (Array.isArray(value) && value.every(item => typeof item === 'string')) own[key] = value
    }
  }
  return { ...inherited, ...own }
}

/**
 * The compiler options a project-reference tsconfig names instead of declaring.
 *
 * A solution-style tsconfig (`files: []` plus `references`) carries no options of
 * its own; the real ones live in the referenced projects. The reference whose
 * config sets `jsx` is preferred, because that is the face a `.tsx` file belongs
 * to, and it is the only distinction these projects make that matters here.
 * @param path - absolute solution tsconfig path.
 * @returns the first referenced project's options, or undefined when none has any.
 */
function referencedOptions(path: string): Record<string, string | number | boolean | readonly string[]> | undefined {
  const parsed = parseJsonc(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const references = (parsed as { references?: unknown }).references
  if (!Array.isArray(references)) return undefined
  let fallback: Record<string, string | number | boolean | readonly string[]> | undefined
  for (const reference of references) {
    if (typeof reference !== 'object' || reference === null) continue
    const target = (reference as { path?: unknown }).path
    if (typeof target !== 'string') continue
    for (const candidate of [resolve(dirname(path), target), resolve(dirname(path), target, 'tsconfig.json')]) {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue
      const options = readCompilerOptions(candidate)
      if (Object.keys(options).length === 0) continue
      if (options.jsx !== undefined) return options
      fallback ??= options
    }
  }
  return fallback
}

/** Options assumed when a project declares none, chosen for React/TS work in the browser. */
const FALLBACK_OPTIONS: Record<string, string | number | boolean | readonly string[]> = {
  target: 'ES2020',
  module: 'ESNext',
  moduleResolution: 'bundler',
  jsx: 'react-jsx',
  strict: true,
}

/**
 * Split a bare specifier into its package name and subpath.
 * @param specifier - e.g. `react/jsx-runtime` or `@scope/pkg/sub`.
 * @returns the package name and the remainder after it.
 */
function packageOf(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier
  return { name, subpath: specifier.slice(name.length).replace(/^\//u, '') }
}

/**
 * The declaration file a package's manifest names, including its `exports` map.
 * @param dir - the package directory.
 * @param manifest - its parsed `package.json`.
 * @param subpath - requested subpath, empty for the package root.
 * @returns the absolute declaration path, or undefined.
 */
function declarationOf(dir: string, manifest: Record<string, unknown>, subpath: string): string | undefined {
  // Only a declaration may be returned. A package that names a JavaScript entry
  // (`react`, whose manifest has no `types`) must fall through to its `@types`
  // sibling instead of resolving to that JS file and stopping the search.
  const pick = (value: unknown): string | undefined => {
    if (typeof value === 'string') return DECLARATION.test(value) ? value : undefined
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    for (const key of ['types', 'typings', 'default', 'import', 'require'] as const) {
      const found = pick(record[key])
      if (found !== undefined) return found
    }
    return undefined
  }
  const exportsField = manifest.exports
  if (typeof exportsField === 'object' && exportsField !== null) {
    const map = exportsField as Record<string, unknown>
    const key = subpath === '' ? '.' : `./${subpath}`
    const targeted = pick(map[key] ?? (subpath === '' ? map['.'] : undefined))
    if (targeted !== undefined) {
      const absolute = resolve(dir, targeted)
      if (existsSync(absolute)) return absolute
    }
  }
  if (subpath !== '') {
    for (const suffix of FILE_SUFFIXES) {
      const candidate = resolve(dir, `${subpath}${suffix}`)
      if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate
    }
    const nested = resolve(dir, subpath, 'index.d.ts')
    return existsSync(nested) ? nested : undefined
  }
  for (const field of ['types', 'typings'] as const) {
    const value = manifest[field]
    if (typeof value === 'string') {
      const absolute = resolve(dir, value)
      if (existsSync(absolute)) return absolute
    }
  }
  for (const fallback of ['index.d.ts', 'index.d.mts', 'index.d.cts']) {
    const candidate = join(dir, fallback)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve one specifier to a declaration file.
 * @param specifier - import specifier as written.
 * @param fromDir - directory of the importing file.
 * @returns the absolute declaration path, or undefined.
 */
function resolveSpecifier(specifier: string, fromDir: string): string | undefined {
  if (specifier.startsWith('.') || isAbsolute(specifier)) return undefined
  const { name, subpath } = packageOf(specifier)
  for (const candidateName of [name, `@types/${name.replace(/^@/u, '').replace('/', '__')}`]) {
    let directory = fromDir
    for (let step = 0; step < 12; step += 1) {
      // A pnpm install keeps undeclared transitive packages in a hidden hoist
      // (`node_modules/.pnpm/node_modules`); a type-only dependency such as
      // csstype lives there and nowhere else, so it is searched beside the
      // ordinary link a declared dependency gets.
      for (const nodeModules of [join(directory, 'node_modules'), join(directory, 'node_modules', '.pnpm', 'node_modules')]) {
        const packageDir = join(nodeModules, candidateName)
        if (!existsSync(packageDir)) continue
        const manifestPath = join(packageDir, 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = parseJsonc(readFileSync(manifestPath, 'utf8'))
        if (typeof manifest !== 'object' || manifest === null) continue
        const found = declarationOf(packageDir, manifest as Record<string, unknown>, subpath)
        if (found !== undefined) return found
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return undefined
}

/**
 * Resolve one relative import to an existing file.
 * @param specifier - relative specifier as written.
 * @param fromDir - directory of the importing file.
 * @returns the absolute file path, or undefined.
 */
function resolveRelative(specifier: string, fromDir: string): string | undefined {
  const base = resolve(fromDir, specifier)
  for (const suffix of FILE_SUFFIXES) {
    const candidate = `${base}${suffix}`
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate
  }
  for (const suffix of ['.d.ts', '.ts', '.tsx', '.js'] as const) {
    const candidate = join(base, `index${suffix}`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Every module specifier one source or declaration file mentions.
 * @param text - file contents.
 * @returns the specifiers, de-duplicated.
 */
function specifiersOf(text: string): readonly string[] {
  const found = new Set<string>()
  for (const pattern of SPECIFIERS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined && !specifier.startsWith('node:')) found.add(specifier)
    }
  }
  for (const match of text.matchAll(REFERENCES)) {
    const reference = match[1]
    if (reference !== undefined) found.add(reference.startsWith('.') ? reference : reference)
  }
  return [...found]
}

/**
 * Read a file's imports without paying for an enormous bundle's full text.
 * @param path - absolute file path.
 * @returns its specifiers, or none when the file is unreadable.
 */
function importsOf(path: string): readonly string[] {
  const info = statSync(path, { throwIfNoEntry: false })
  if (info?.isFile() !== true || info.size > MAX_SCAN_BYTES) return []
  try {
    return specifiersOf(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Collect the declaration closure and compiler options for one file.
 * @param filePath - absolute path of the edited file.
 * @returns the payload Monaco's worker receives, with notes about any bound hit.
 */
export function collectTypes(filePath: string): TypePayload {
  const absolute = resolve(filePath)
  const notes: string[] = []
  /** Record one note at most once, keeping the list short and ordered. */
  const note = (text: string): void => {
    if (!notes.includes(text) && notes.length < 12) notes.push(text)
  }

  const configPath = findTsconfig(dirname(absolute))
  let options: Record<string, string | number | boolean | readonly string[]> = {}
  if (configPath !== undefined) {
    options = readCompilerOptions(configPath)
    if (Object.keys(options).length === 0) options = referencedOptions(configPath) ?? {}
  }
  if (Object.keys(options).length === 0) {
    options = FALLBACK_OPTIONS
    note(configPath === undefined
      ? 'no tsconfig.json found; using default compiler options'
      : 'tsconfig declares no compiler options; using defaults')
  }

  const libraries: TypeLibrary[] = []
  const seen = new Set<string>()
  let bytes = 0
  const queue: { path: string; depth: number }[] = []

  /**
   * Admit one resolved file at a depth, then queue its own imports.
   *
   * Only declarations are admitted: a project source file is not an ambient
   * library, and following its imports would walk the whole repository instead
   * of the surface the edited file actually uses.
   */
  const admit = (path: string, depth: number): void => {
    if (!DECLARATION.test(path) || seen.has(path) || depth > MAX_DEPTH) return
    if (libraries.length >= MAX_LIBRARIES) {
      note('declaration closure truncated')
      return
    }
    seen.add(path)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return
    }
    if (bytes + text.length > MAX_BYTES) {
      note('declaration bytes truncated')
      return
    }
    bytes += text.length
    libraries.push({ path, text })
    queue.push({ path, depth })
  }

  let unresolved = 0
  for (const specifier of importsOf(absolute)) {
    const resolved = specifier.startsWith('.')
      ? resolveRelative(specifier, dirname(absolute))
      : resolveSpecifier(specifier, dirname(absolute))
    if (resolved !== undefined) admit(resolved, 1)
    else if (!specifier.startsWith('.')) unresolved += 1
  }

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const specifier of importsOf(current.path)) {
      const resolved = specifier.startsWith('.')
        ? resolveRelative(specifier, dirname(current.path))
        : resolveSpecifier(specifier, dirname(current.path))
      if (resolved !== undefined) admit(resolved, current.depth + 1)
    }
  }

  // One aggregate line instead of one per import: a workspace whose packages
  // ship no built declarations (a source checkout) resolves nothing, and a note
  // per specifier turns the status hint into noise.
  if (unresolved > 0) note(`${String(unresolved)} imported module(s) without type declarations`)

  return { path: absolute, options, libraries, notes }
}
