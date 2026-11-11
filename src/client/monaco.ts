/**
 * Load Monaco on demand and teach its TypeScript worker about the project.
 *
 * Monaco is not imported: it is an AMD build served by this plugin's Host, and
 * the browser loads it the first time a file is opened for editing. The entry
 * module (`vs/editor/editor.main`) installs its own `MonacoEnvironment`, so its
 * four workers resolve relative to the same served tree — no worker setup here.
 *
 * Once loaded, the worker still knows nothing about the workspace: it can
 * complete local symbols but not a library's API. {@link configureTypes} closes
 * that gap by registering the Host's declaration closure as ambient libraries
 * under `file://` paths that mirror their real location, which is what lets the
 * worker resolve `import 'react'` at all.
 *
 * @module dsh-explorer-editor/client/monaco
 */
import type { TypePayload } from '../protocol.ts'

/** The slice of Monaco's API this plugin uses. */
export interface MonacoApi {
  readonly editor: {
    create(element: HTMLElement, options: Record<string, unknown>): MonacoEditor
    createModel(value: string, language: string, uri: MonacoUri): MonacoModel
  }
  /** Keybinding modifiers and key codes live on the Monaco root, not on `editor`. */
  readonly KeyMod: { readonly CtrlCmd: number }
  readonly KeyCode: { readonly KeyS: number }
  readonly languages: {
    readonly typescript: MonacoTypeScript
  }
  readonly Uri: {
    file(path: string): MonacoUri
  }
}

/** One Monaco model, holding the file's text and language. */
export interface MonacoModel {
  getValue(): string
  setValue(value: string): void
  setLanguage(language: string): void
  dispose(): void
  onDidChangeContent(listener: () => void): { dispose(): void }
}

/** One Monaco editor instance bound to a model. */
export interface MonacoEditor {
  getModel(): MonacoModel | null
  setModel(model: MonacoModel | null): void
  focus(): void
  layout(): void
  dispose(): void
  addCommand(keybinding: number, handler: () => void): void
  onDidChangeModelContent(listener: () => void): { dispose(): void }
}

/** Monaco's URI value, opaque to this plugin beyond identity. */
export interface MonacoUri {
  readonly path: string
}

/** Monaco's TypeScript language defaults, narrowed to the calls used here. */
export interface MonacoTypeScript {
  readonly typescriptDefaults: MonacoTsDefaults
  readonly javascriptDefaults: MonacoTsDefaults
  readonly ScriptTarget?: Record<string, unknown>
  readonly ModuleKind?: Record<string, unknown>
  readonly ModuleResolutionKind?: Record<string, unknown>
  readonly JsxEmit?: Record<string, unknown>
}

/** One language's defaults: compiler options, diagnostics, and ambient libraries. */
export interface MonacoTsDefaults {
  setEagerModelSync(value: boolean): void
  setCompilerOptions(options: Record<string, unknown>): void
  setDiagnosticsOptions(options: Record<string, unknown>): void
  addExtraLib(content: string, filePath?: string): void
}

/** The AMD loader Monaco's build installs on `window`. */
interface AmdRequire {
  (dependencies: string[], onLoad: () => void, onError?: (error: unknown) => void): void
  config(options: { paths: Record<string, string> }): void
}

/** Global surface the Monaco build and this loader share. */
interface MonacoWindow {
  monaco?: MonacoApi
  require?: AmdRequire
  define?: AmdDefine
}

/** The AMD `define` function Monaco's loader publishes on `window`. */
interface AmdDefine {
  amd?: unknown
}

const scope = globalThis as unknown as MonacoWindow

/**
 * Remove the AMD marker Monaco's loader publishes as `define.amd`.
 *
 * UMD bundles elsewhere on the page test `define.amd` before falling back to
 * `module.exports` — the spreadsheet preview's `numeral` does exactly that — so
 * while the marker is set they register an anonymous AMD module and never assign
 * their exports. The consumer that needed them then throws during render and its
 * view comes up blank (a black table).
 *
 * Monaco reads the marker only while its own loader initializes, so clearing it
 * once the build is up restores normal UMD behaviour for every other bundle and
 * leaves Monaco's lazy language modules working: they still call `define(...)`,
 * which stays installed, and never look at the marker.
 * @param target - the global object the loader published `define` on.
 */
export function releaseAmdMarker(target: { define?: AmdDefine }): void {
  const define = target.define
  if (define !== undefined && define.amd !== undefined) delete define.amd
}

/** The one in-flight load, shared by every editor instance. */
let loading: Promise<MonacoApi> | undefined

/**
 * Build the `file://` URI Monaco's worker uses for a Host path.
 * @param path - absolute path as the Host reports it.
 * @returns a file URI with forward slashes.
 */
export function fileUriOf(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/u, '')
  return `file:///${normalized}`
}

/**
 * Load Monaco's AMD build from the served tree.
 * @param base - URL prefix the Host serves the build under (no trailing slash).
 * @returns the initialized Monaco API.
 */
export function loadMonaco(base: string): Promise<MonacoApi> {
  loading ??= new Promise<MonacoApi>((resolve, reject) => {
    if (scope.monaco !== undefined) {
      releaseAmdMarker(scope)
      resolve(scope.monaco)
      return
    }
    const script = document.createElement('script')
    script.src = `${base}/vs/loader.js`
    script.async = true
    script.dataset.explorerEditor = 'monaco-loader'
    script.onerror = () => { reject(new Error(`could not load ${script.src}`)) }
    script.onload = () => {
      const amd = scope.require
      if (amd === undefined) {
        reject(new Error('the Monaco AMD loader did not install require()'))
        return
      }
      amd.config({ paths: { vs: `${base}/vs` } })
      amd(['vs/editor/editor.main'], () => {
        const api = scope.monaco
        if (api === undefined) {
          reject(new Error('the Monaco entry module did not publish monaco'))
          return
        }
        // The editor is up; hand the page back its UMD semantics (see above).
        releaseAmdMarker(scope)
        resolve(api)
      }, (error: unknown) => { reject(error instanceof Error ? error : new Error(String(error))) })
    }
    document.head.appendChild(script)
  })
  return loading
}

/**
 * Find an enum member by the name a tsconfig would use.
 * @param members - the Monaco enum object.
 * @param value - tsconfig spelling, e.g. `ES2020`, `react-jsx`, `bundler`.
 * @param aliases - extra tsconfig spelling to enum-name mappings.
 * @returns the enum value, or undefined when the name is unknown.
 */
function enumValue(
  members: Record<string, unknown> | undefined,
  value: unknown,
  aliases: Record<string, string> = {},
): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || members === undefined) return undefined
  const wanted = (aliases[value.toLowerCase()] ?? value).replaceAll(/[-_]/gu, '').toLowerCase()
  for (const [name, member] of Object.entries(members)) {
    if (typeof member !== 'number') continue
    if (name.replaceAll(/[-_]/gu, '').toLowerCase() === wanted) return member
  }
  return undefined
}

/** tsconfig spellings whose enum member name differs from the spelling. */
const RESOLUTION_ALIASES: Record<string, string> = {
  node: 'NodeJs',
  node10: 'Node10',
  node16: 'Node16',
  nodenext: 'NodeNext',
  bundler: 'Bundler',
  classic: 'Classic',
}

/** tsconfig options applied to Monaco's worker, in enum terms. */
function compilerOptions(ts: MonacoTypeScript, declared: TypePayload['options']): Record<string, unknown> {
  const options: Record<string, unknown> = {
    allowNonTsExtensions: true,
    allowJs: declared.allowJs === true,
    checkJs: declared.checkJs === true,
    isolatedModules: declared.isolatedModules === true,
    esModuleInterop: declared.esModuleInterop !== false,
    allowSyntheticDefaultImports: declared.allowSyntheticDefaultImports !== false,
    // An empty `types` list keeps the worker from pretending to know every
    // ambient package; the closure this plugin sends is the whole truth.
    types: [],
  }
  const target = enumValue(ts.ScriptTarget, declared.target)
  if (target !== undefined) options.target = target
  const module = enumValue(ts.ModuleKind, declared.module)
  if (module !== undefined) options.module = module
  const resolution = enumValue(ts.ModuleResolutionKind, declared.moduleResolution, RESOLUTION_ALIASES)
  if (resolution !== undefined) options.moduleResolution = resolution
  const jsx = enumValue(ts.JsxEmit, declared.jsx)
  if (jsx !== undefined) options.jsx = jsx
  for (const flag of ['strict', 'noImplicitAny', 'strictNullChecks', 'resolveJsonModule'] as const) {
    if (declared[flag] !== undefined) options[flag] = declared[flag]
  }
  return options
}

/**
 * Register the project's declaration closure with Monaco's TypeScript workers.
 *
 * Diagnostics are limited to syntax: the worker only sees declarations, not the
 * project's other sources, so semantic errors about unresolved modules would be
 * noise rather than signal. Completion and hover still use the full closure.
 * @param api - the loaded Monaco API.
 * @param payload - the Host's type payload for the open file.
 */
export function configureTypes(api: MonacoApi, payload: TypePayload): void {
  const ts = api.languages.typescript
  const options = compilerOptions(ts, payload.options)
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setEagerModelSync(true)
    defaults.setCompilerOptions(options)
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
    for (const library of payload.libraries) defaults.addExtraLib(library.text, fileUriOf(library.path))
  }
}
