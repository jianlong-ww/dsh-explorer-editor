/**
 * The editable document body: a Monaco editor mounted where the read-only
 * preview used to be.
 *
 * The preview panel picks a body by file suffix, and this implementation wins
 * for source files, so the built-in text body is never mounted for them — the
 * editor replaces it inside the same tab, with the tab's own header, toolbar,
 * reload control, and scroll container unchanged.
 *
 * Reading and saving are unchanged from the modal version: the same Host route,
 * the same version CAS, the same sandbox and containment checks. What changed is
 * where the text is edited and what the worker knows: the Host also sends the
 * project's declaration closure, so completion covers library APIs rather than
 * only the file's own symbols.
 *
 * @module dsh-explorer-editor/client/preview
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SaveRequest, TypePayload } from '../protocol.ts'
import { languageOf, parseFileAddress } from './address.ts'
import { configureTypes, loadMonaco } from './monaco.ts'
import type { MonacoApi, MonacoEditor, MonacoModel } from './monaco.ts'
import type { EditorFailure, ReadOutcome, SaveOutcome } from './outcome.ts'
import { NS, type ExplorerEditorKey } from './locales.ts'

/** Effects the body receives from its registration, captured from the plugin context. */
export interface EditorDeps {
  /** URL prefix the Host serves Monaco's build under. */
  readonly monacoBase: string
  /** Largest text this deployment lets the editor open and save. */
  readonly maxBytes: () => Promise<number>
  /** Read one file's complete text and version. */
  readonly read: (sessionId: string, path: string, signal: AbortSignal) => Promise<ReadOutcome>
  /** Write one file, version-guarded. */
  readonly save: (request: SaveRequest, signal: AbortSignal) => Promise<SaveOutcome>
  /** Fetch the project's declaration closure for one file. */
  readonly types: (sessionId: string, path: string, signal: AbortSignal) => Promise<TypePayload | undefined>
}

/** Props of the document body seat. */
export type EditorBodyProps = PropsRuntime<'sidebar.right.tab.document'>
  & PropsLocale<typeof NS>
  & InjectFace<EditorDeps>

/** Where the editor is in its lifecycle. */
type Phase = 'loading' | 'ready' | 'saving' | 'failed'

/** Frame: the body owns the tab's whole content area. */
const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  width: '100%',
}

/** Status strip above the editor. */
const BAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '4px 8px',
  fontSize: '12px',
  borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.25))',
  flex: '0 0 auto',
}

/** Dimmed text in the strip. */
const META_STYLE: CSSProperties = { opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

/** Flexible editor host. */
const EDITOR_STYLE: CSSProperties = { flex: '1 1 auto', minHeight: 0, position: 'relative' }

/** Inline banner for a failure or a conflict. */
const BANNER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 8px',
  fontSize: '12px',
  background: 'var(--dsw-alias-bg-danger, rgba(220, 38, 38, 0.10))',
  color: 'var(--dsw-alias-text-danger, #b91c1c)',
  flex: '0 0 auto',
}

/**
 * Pick a Monaco theme that matches the shell.
 * @returns `vs-dark` when the document is in dark mode, else `vs`.
 */
function themeOf(): string {
  const declared = document.documentElement.dataset.theme ?? document.documentElement.dataset.colorScheme
  if (declared !== undefined) return declared.toLowerCase().includes('dark') ? 'vs-dark' : 'vs'
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'vs-dark' : 'vs'
}

/**
 * Render the editable body for one open file.
 * @param props - the tab's content seat, the project effects, and localized copy.
 * @returns the editor, or a status line while it loads or after it fails.
 */
export function EditorBody(props: EditorBodyProps): ReactNode {
  const { content, resourceAddress, sessionId, t, monacoBase, maxBytes, read, save, types } = props
  const address = useMemo(() => parseFileAddress(resourceAddress), [resourceAddress])
  const path = address?.path ?? ''
  const session = address?.sessionId ?? String(sessionId ?? '')
  const [phase, setPhase] = useState<Phase>('loading')
  const [failure, setFailure] = useState<EditorFailure | undefined>(undefined)
  const [conflict, setConflict] = useState<string | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [notes, setNotes] = useState<readonly string[]>([])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditor | null>(null)
  const modelRef = useRef<MonacoModel | null>(null)
  const apiRef = useRef<MonacoApi | null>(null)
  const baselineRef = useRef('')
  const versionRef = useRef('')
  const saveRef = useRef<() => void>(() => {})

  const reload = useCallback((signal?: AbortSignal): Promise<void> => {
    const controller = signal === undefined ? new AbortController() : undefined
    const requestSignal = signal ?? controller!.signal
    setPhase('loading')
    setFailure(undefined)
    setConflict(undefined)
    return (async () => {
      const outcome = await read(session, path, requestSignal)
      if (requestSignal.aborted) return
      if (!outcome.ok) {
        setPhase('failed')
        setFailure(outcome.failure)
        if (content.kind === 'renderer') content.failed()
        return
      }
      const limit = await maxBytes()
      if (outcome.value.bytes > limit) {
        setPhase('failed')
        setFailure({ code: 'too-large', message: `"${path}" exceeds the ${String(limit)} byte edit cap`, limit })
        return
      }
      baselineRef.current = outcome.value.text
      versionRef.current = outcome.value.version
      const editor = editorRef.current
      const model = modelRef.current
      if (model !== null) model.setValue(outcome.value.text)
      editor?.setModel(model)
      setDirty(false)
      setPhase('ready')
      if (content.kind === 'renderer') content.loaded(outcome.value.version)
    })()
  }, [content, maxBytes, path, read, session])

  /** Write the current buffer under a version, or under the conflicting one. */
  const write = useCallback((expectedVersion: string): void => {
    const model = modelRef.current
    if (model === null) return
    setPhase('saving')
    setConflict(undefined)
    setFailure(undefined)
    const text = model.getValue()
    void (async () => {
      const outcome = await save({ sessionId: session, path, text, expectedVersion }, new AbortController().signal)
      if (outcome.ok) {
        baselineRef.current = text
        versionRef.current = outcome.value.version
        setDirty(false)
        setPhase('ready')
        if (content.kind === 'renderer') content.loaded(outcome.value.version)
        return
      }
      if (outcome.failure.code === 'stale-version') {
        setPhase('ready')
        setConflict(outcome.failure.currentVersion ?? '')
        return
      }
      setPhase('ready')
      setFailure(outcome.failure)
    })()
  }, [content, path, save, session])

  /** Save the buffer when it differs from what was read. */
  const commit = useCallback((): void => {
    const model = modelRef.current
    if (model === null || phase === 'saving' || phase === 'loading') return
    if (model.getValue() === baselineRef.current) return
    write(versionRef.current)
  }, [phase, write])
  saveRef.current = commit

  useEffect(() => {
    if (address === undefined) {
      setPhase('failed')
      setFailure({ code: 'read-failed', message: `"${resourceAddress}" is not a file address` })
      return
    }
    let disposed = false
    const controller = new AbortController()
    const host = containerRef.current
    setPhase('loading')
    setFailure(undefined)
    setConflict(undefined)
    setDirty(false)
    void (async () => {
      let api: MonacoApi
      try {
        api = await loadMonaco(monacoBase)
      } catch (error: unknown) {
        if (disposed) return
        setPhase('failed')
        setFailure({ code: 'editor-load', message: error instanceof Error ? error.message : String(error) })
        return
      }
      if (disposed || host === null) return
      apiRef.current = api
      const outcome = await read(session, path, controller.signal)
      if (disposed || controller.signal.aborted) return
      if (!outcome.ok) {
        setPhase('failed')
        setFailure(outcome.failure)
        if (content.kind === 'renderer') content.failed()
        return
      }
      const limit = await maxBytes()
      if (outcome.value.bytes > limit) {
        setPhase('failed')
        setFailure({ code: 'too-large', message: `"${path}" exceeds the ${String(limit)} byte edit cap`, limit })
        return
      }
      const payload = await types(session, path, controller.signal).catch(() => undefined)
      if (disposed) return
      if (payload !== undefined) {
        configureTypes(api, payload)
        setNotes(payload.notes)
      }
      try {
        const uri = api.Uri.file(payload?.path ?? path)
        const model = api.editor.createModel(outcome.value.text, languageOf(path), uri)
        const editor = api.editor.create(host, {
          model,
          theme: themeOf(),
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 20,
          tabSize: 2,
          scrollBeyondLastLine: false,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          wordWrap: props.wrap === true ? 'on' : 'off',
          renderWhitespace: 'selection',
          fixedOverflowWidgets: true,
        })
        editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => { saveRef.current() })
        model.onDidChangeContent(() => { setDirty(model.getValue() !== baselineRef.current) })
        baselineRef.current = outcome.value.text
        versionRef.current = outcome.value.version
        modelRef.current = model
        editorRef.current = editor
        setPhase('ready')
        if (content.kind === 'renderer') content.loaded(outcome.value.version)
        editor.focus()
      } catch (error: unknown) {
        // A mount failure must land in the status strip, not leave the tab
        // spinning: this is the only place the editor is created.
        if (disposed) return
        setPhase('failed')
        setFailure({
          code: 'editor-load',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })()
    return () => {
      disposed = true
      controller.abort()
      editorRef.current?.dispose()
      modelRef.current?.dispose()
      editorRef.current = null
      modelRef.current = null
    }
    // The effect owns the editor for one tab; `t` and the effects are stable
    // closures over the plugin context, so they are not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceAddress])

  const banner = conflict !== undefined
    ? (
      <div style={BANNER_STYLE} role="alert">
        <span>{t('editor.conflict')}</span>
        <Button size="sm" onClick={() => { void reload() }}>{t('editor.reloadFromDisk')}</Button>
        <Button size="sm" variant="primary" onClick={() => { write(conflict) }}>{t('editor.overwrite')}</Button>
      </div>
    )
    : failure !== undefined
      ? (
        <div style={BANNER_STYLE} role="alert">
          <span>{copyOf(t, failure)}</span>
          <Button size="sm" onClick={() => { void reload() }}>{t('editor.reloadFromDisk')}</Button>
        </div>
      )
      : null

  return (
    <div style={ROOT_STYLE} ref={hostRef}>
      <div style={BAR_STYLE}>
        <span style={{ ...META_STYLE, flex: '1 1 auto' }} title={path}>{path}</span>
        {dirty && <span style={META_STYLE}>{t('editor.unsaved')}</span>}
        {notes.length > 0 && <span style={META_STYLE} title={notes.join('\n')}>{t('editor.limitedTypes')}</span>}
        <Button size="sm" onClick={() => { void reload() }}>{t('editor.reloadFromDisk')}</Button>
        <Button size="sm" variant="primary" onClick={commit} disabled={!dirty || phase === 'saving' || phase === 'loading'}>
          {phase === 'saving' ? t('editor.saving') : t('editor.save')}
        </Button>
      </div>
      {banner}
      {phase === 'loading' && <div style={{ ...META_STYLE, padding: '8px' }}>{t('editor.loading')}</div>}
      <div ref={containerRef} style={{ ...EDITOR_STYLE, display: phase === 'ready' || phase === 'saving' ? 'block' : 'none' }} />
    </div>
  )
}

/**
 * Copy for one failure, falling back to the code's generic sentence.
 * @param t - namespace-bound translate.
 * @param failure - the failure to render.
 * @returns the sentence to show.
 */
function copyOf(
  t: (key: ExplorerEditorKey, params?: Record<string, unknown>) => string,
  failure: EditorFailure,
): string {
  const known: ReadonlySet<string> = new Set([
    'bad-request', 'not-found', 'outside-workspace', 'stale-version', 'too-large', 'denied',
    'not-regular-file', 'io-error', 'not-text', 'binary', 'read-failed', 'offline', 'http',
  ])
  const key = known.has(failure.code) ? `error.${failure.code}` : 'error.editor-load'
  const params = failure.limit === undefined
    ? undefined
    : { limit: `${String(Math.max(1, Math.round(failure.limit / 1024)))} KB` }
  return t(key as ExplorerEditorKey, params)
}
