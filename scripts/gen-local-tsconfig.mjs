/**
 * Generate `tsconfig.local.json`: the project tsconfig plus source-level
 * `paths` aliases for every `@deepseek-ai/*` package in a local harness
 * checkout.
 *
 * The shipped package resolves those packages from the Host's `node_modules`
 * at the version DSH runs. A checkout has no built `lib/` — and the app bundle
 * ships no `.d.ts` at all — so checking this repository's types requires the
 * same source aliases the harness uses for itself. This script reads them
 * out of the harness tsconfig (TypeScript's own parser, so comments, `extends`
 * and duplicate keys behave exactly as they do there) and rewrites each target
 * to point into the checkout.
 *
 * Usage: node scripts/gen-local-tsconfig.mjs [--harness <dir>]
 */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const index = process.argv.indexOf('--harness')
const harness = resolve(index === -1 ? resolve(root, '..', 'deepseek-harness') : (process.argv[index + 1] ?? ''))
const configPath = resolve(harness, 'tsconfig.base.json')

if (!existsSync(configPath)) {
  console.error(`no harness tsconfig at ${configPath}; pass --harness <checkout>`)
  process.exit(1)
}

const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path))
if (read.error !== undefined) {
  console.error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, harness)
const sourcePaths = parsed.options.paths
if (sourcePaths === undefined) {
  console.error(`no compilerOptions.paths in ${configPath}`)
  process.exit(1)
}

/**
 * Rewrite one alias target to a project-relative path.
 * @param target - harness-relative target from the tsconfig.
 * @returns a `./`- or `../`-prefixed POSIX path.
 */
function alias(target) {
  const path = relative(root, resolve(harness, target.replace(/^\.\//u, ''))).replaceAll('\\', '/')
  return path.startsWith('./') || path.startsWith('../') ? path : `./${path}`
}

const paths = {}
for (const [key, targets] of Object.entries(sourcePaths)) paths[key] = targets.map(alias)

writeFileSync(resolve(root, 'tsconfig.local.json'), `${JSON.stringify({
  extends: './tsconfig.json',
  compilerOptions: {
    // `bundler` resolves a `paths` target that names a directory through its
    // `index.ts`, which is how every alias above is written.
    module: 'preserve',
    moduleResolution: 'bundler',
    noEmit: true,
    paths,
  },
}, null, 2)}\n`)
console.log(`wrote tsconfig.local.json with ${String(Object.keys(paths).length)} path aliases from ${harness}`)
