/**
 * Copy Monaco's browser build into this package, pruned to what the editor
 * actually needs.
 *
 * Monaco ships four trees under `monaco-editor/`: `esm/` (unbundled ESM),
 * `dev/` (development build), `min-maps/`, and `min/` (the production bundle
 * the browser loads). Only `min/vs` is published here, minus two things we can
 * prove are redundant:
 *
 * - `language/` repeats the four workers that `assets/` already holds (the
 *   entry module `editor.main.js` imports the `assets/` copies), so it costs
 *   ~7.6 MB and is never requested;
 * - `nls/lang/*.js` holds one UI-translation bundle per language and English is
 *   built into the entry, so only the two Chinese bundles are kept.
 *
 * The result is served by this plugin's own Host route (`/explorer-editor/
 * monaco/*`): DSH's package-asset route only carries images, and Monaco's
 * entry module resolves its chunks, CSS, and workers relative to this tree.
 *
 * Usage: node scripts/sync-monaco.mjs [--from <monaco package dir>]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const index = process.argv.indexOf('--from')
const candidates = [
  index === -1 ? undefined : resolve(process.argv[index + 1] ?? ''),
  process.env.MONACO_DIR === undefined ? undefined : resolve(process.env.MONACO_DIR),
  resolve(root, 'node_modules', 'monaco-editor'),
  resolve(root, '..', 'monaco-editor'),
].filter((candidate) => candidate !== undefined && existsSync(join(candidate, 'min', 'vs')))

const source = candidates[0]
if (source === undefined) {
  console.error('no monaco-editor build found. Install it (pnpm add -D monaco-editor@0.57.0),')
  console.error('or point at an existing copy with --from <dir> or MONACO_DIR=<dir>.')
  process.exit(1)
}

const from = join(source, 'min', 'vs')
const to = resolve(root, 'lib', 'monaco', 'vs')
rmSync(to, { recursive: true, force: true })
mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true })

/** Remove one file or subtree and report the bytes it freed. */
function drop(path) {
  const target = join(to, path)
  const info = statSync(target, { throwIfNoEntry: false })
  if (info === undefined) return 0
  let freed = 0
  if (info.isFile()) {
    freed = info.size
  } else {
    for (const entry of readdirSync(target, { recursive: true })) {
      const file = join(target, String(entry))
      const child = statSync(file, { throwIfNoEntry: false })
      if (child?.isFile() === true) freed += child.size
    }
  }
  rmSync(target, { recursive: true, force: true })
  return freed
}

let freed = drop('language')
const nlsDir = join(to, 'nls', 'lang')
if (existsSync(nlsDir)) {
  for (const entry of readdirSync(nlsDir)) {
    if (/^zh-(cn|tw)\.(js|d\.ts)$/u.test(entry)) continue
    freed += drop(join('nls', 'lang', entry))
  }
}

/** Total bytes and file count of the published tree. */
function measure(dir) {
  let bytes = 0
  let files = 0
  for (const entry of readdirSync(dir, { recursive: true })) {
    const info = statSync(join(dir, String(entry)), { throwIfNoEntry: false })
    if (info?.isFile() === true) {
      bytes += info.size
      files += 1
    }
  }
  return { bytes, files }
}

const kept = measure(to)
const entry = join(to, 'editor', 'editor.main.js')
if (!existsSync(entry)) {
  console.error(`pruned tree lost its entry module: ${entry}`)
  process.exit(1)
}
console.log(`synced monaco from ${source}`)
console.log(`  published: ${(kept.bytes / 1e6).toFixed(1)} MB in ${String(kept.files)} files (dropped ${(freed / 1e6).toFixed(1)} MB)`)
console.log(`  entry:     lib/monaco/vs/editor/editor.main.js`)
