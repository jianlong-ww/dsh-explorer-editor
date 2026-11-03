/**
 * Typecheck this repository against a local harness checkout.
 *
 * Outside the harness, the `@deepseek-ai/*` packages have no build output, so
 * the aliases in `tsconfig.local.json` point at their sources. Several of those
 * packages import their own *generated* Typert faces (`<pkg>/remote`), which a
 * checkout does not contain — the harness generates them during `pnpm build`.
 * Those diagnostics are therefore expected in this environment and belong to
 * the checkout, not to this package.
 *
 * The gate that matters is this package: every diagnostic whose file lives in
 * `src/`, `tests/`, or `tsdown.config.ts` fails the run. Diagnostics inside the
 * checkout are counted and reported, never silently mixed in.
 *
 * Usage: node scripts/typecheck.mjs
 */
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const read = ts.readConfigFile(resolve(root, 'tsconfig.local.json'), (path) => ts.sys.readFile(path))
if (read.error !== undefined) {
  console.error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const diagnostics = ts.getPreEmitDiagnostics(program)

/** Whether a diagnostic's file belongs to this repository's own sources. */
function own(fileName) {
  const path = relative(root, fileName).replaceAll('\\', '/')
  return !path.startsWith('..') && (path.startsWith('src/') || path.startsWith('tests/') || path === 'tsdown.config.ts')
}

/**
 * Render one diagnostic the way the compiler would.
 * @param diagnostic - the compiler diagnostic.
 * @returns a single message, file position first when known.
 */
function render(diagnostic) {
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  if (diagnostic.file === undefined || diagnostic.start === undefined) return text
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  const path = relative(root, diagnostic.file.fileName).replaceAll('\\', '/')
  return `${path}:${String(line + 1)}:${String(character + 1)} - ${text}`
}

const ownDiagnostics = diagnostics.filter(d => d.file !== undefined && isAbsolute(d.file.fileName) && own(d.file.fileName))
const external = diagnostics.length - ownDiagnostics.length

for (const diagnostic of ownDiagnostics) console.error(render(diagnostic))
if (external > 0) {
  console.log(`${String(external)} diagnostic(s) inside the harness checkout (packages without generated Typert faces) were ignored.`)
}
if (ownDiagnostics.length > 0) {
  console.error(`\n${String(ownDiagnostics.length)} error(s) in this package.`)
  process.exit(1)
}
console.log(`typecheck clean: ${String(program.getSourceFiles().length)} files in the program, 0 errors in this package.`)
