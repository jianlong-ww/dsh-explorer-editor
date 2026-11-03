/**
 * Client half: an editable document body for source files.
 *
 * The plugin registers itself in the preview panel's renderer registry for the
 * suffixes an editor serves. The panel picks one body per file, and this
 * implementation outranks the built-in text viewer, so the file opens editable
 * in place — same tab, same header, same toolbar.
 *
 * Reading uses the Host's read-only `workspaceFiles` Remote; saving posts to
 * this plugin's Host route, which owns the sandbox, containment, and version
 * checks; project types come from the Host so Monaco's worker can complete
 * library APIs.
 *
 * @module dsh-explorer-editor/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { MONACO_PREFIX } from '../protocol.ts'
import { dictionaries, NS, type ExplorerEditorKey } from './locales.ts'
import { EditorBody, type EditorDeps } from './preview.tsx'
import { readEditableFile } from './read.ts'
import { DEFAULT_MAX_WRITE_BYTES, fetchDeploymentFacts, fetchTypes, postSave } from './save.ts'

/** Document implementation id; also the keyed body slot's key and the view's name in the menu. */
export const EDITOR_PREVIEW_ID = 'dsh-explorer-editor/editor'

/**
 * Suffixes this implementation serves.
 *
 * The list is deliberately broad: any text file the built-in viewer would show
 * should open editable instead, so code, config, markup, and prose formats are
 * all claimed. Binaries are never listed, and a viewer that renders something
 * better than text (Markdown's headings and links, images, PDFs) stays
 * available as an alternative view in the toolbar — claiming the suffix only
 * decides which view opens first.
 *
 * Dotfiles are claimed through their own dot-name: the preview matches a
 * filename against `.<suffix>`, so `.gitignore` is suffix `gitignore`. Files
 * with no dot at all (`Makefile`, `LICENSE`) and unlisted suffixes cannot be
 * expressed this way; the preview has no "match anything" rule, and the
 * built-in plain-text fallback is identified by a fixed id an external plugin
 * cannot register under.
 */
const EXTENSIONS = [
  // code
  'ts', 'tsx', 'mts', 'cts',
  'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'kts', 'rb', 'php', 'cs', 'swift',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'm', 'mm',
  // markup and data
  'json', 'jsonc', 'json5', 'css', 'scss', 'less', 'html', 'htm', 'xml',
  'vue', 'svelte', 'graphql', 'gql',
  // prose and docs
  'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc',
  // configuration and scripts
  'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'gradle', 'sql', 'lock', 'log',
  // dotfiles, by their dot-name (`.gitignore` is suffix `gitignore`)
  'gitignore', 'gitattributes', 'gitmodules', 'gitkeep', 'git-blame-ignore-revs',
  'npmrc', 'nvmrc', 'yarnrc', 'pnpmfile', 'editorconfig',
  'prettierrc', 'prettierignore', 'eslintrc', 'eslintignore', 'stylelintrc',
  'babelrc', 'browserslistrc', 'dockerignore', 'watchmanconfig', 'mailmap',
  'huskyrc', 'lintstagedrc', 'clang-format', 'clang-tidy', 'tool-versions',
  'ruby-version', 'python-version', 'node-version', 'terraformrc',
]

export { inject, name } from './manifest.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The editor's view name, status strip, and failure copy. */
    explorerEditor: ExplorerEditorKey
  }
}

/**
 * Client plugin body: dictionaries, the editable document implementation, and
 * the effects its component runs against.
 * @param ctx - client root context carrying the preview registry, slots, copy, and the file Remote.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'explorer editor: dictionaries')
  const t = ctx.locale.bind(NS)
  let limit: Promise<number> | undefined
  /** Read the Host's cap once per page and reuse it. */
  const maxBytes = async (): Promise<number> => {
    limit ??= (async () => {
      const facts = await fetchDeploymentFacts(new AbortController().signal)
      return facts?.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES
    })()
    return limit
  }
  const deps: EditorDeps = {
    monacoBase: MONACO_PREFIX,
    maxBytes,
    read: (sessionId, path, signal) => readEditableFile(ctx, sessionId, path, signal),
    save: (request, signal) => postSave(request, signal),
    types: (sessionId, path, signal) => fetchTypes(sessionId, path, signal),
  }
  ctx.effect(() => ctx.documentPreviews.register({
    id: EDITOR_PREVIEW_ID,
    extensions: EXTENSIONS,
    priority: 'extension',
    title: () => t('viewer.editor'),
    // The body loads its own content: it needs the bytes and the version those
    // bytes carried, and it must report that version back to the tab.
    loading: 'renderer',
    wrap: true,
  }), 'explorer editor: document implementation')
  ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document',
    key: EDITOR_PREVIEW_ID,
    locale: NS,
    inject: () => deps,
  }, EditorBody))
}
