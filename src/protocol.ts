/**
 * Wire contract shared by the Host route and the browser editor.
 *
 * The Host half serves one JSON endpoint (`SAVE_ROUTE`) on the composed Web
 * server; the browser half calls it with `fetch`. Nothing here is
 * environment-specific, so both faces import these types without a runtime
 * dependency between them.
 *
 * @module dsh-explorer-editor/protocol
 */

/** Path of the one route the Host half registers. */
export const SAVE_ROUTE = '/explorer-editor/api/save'

/** Path of the read-only deployment-facts route the editor reads before opening a file. */
export const STATE_ROUTE = '/explorer-editor/api/state'

/** Path of the project-type payload the editor feeds Monaco's TypeScript worker. */
export const TYPES_ROUTE = '/explorer-editor/api/types'

/** Prefix of the served Monaco build; the editor resolves its chunks and workers under it. */
export const MONACO_PREFIX = '/explorer-editor/monaco'

/**
 * Header the browser must send with every request. It makes the call a
 * non-simple CORS request, so a cross-site form post cannot reach the route,
 * and it gives the Host a cheap "this came from our own client" signal beside
 * the same-origin check.
 */
export const REQUEST_HEADER = 'x-explorer-editor-request'

/** Body of one save call. */
export interface SaveRequest {
  /** Session whose workspace root and sandbox mode the save runs under. */
  readonly sessionId: string
  /** Target path, absolute or relative to the Session workspace root. */
  readonly path: string
  /** Complete replacement text, decoded from the bytes the browser read. */
  readonly text: string
  /** Version the browser read before editing; the write only lands if it still holds. */
  readonly expectedVersion: string
}

/** Why a save failed; the browser maps each code to its own copy. */
export type SaveFailureCode =
  | 'bad-request'
  | 'not-found'
  | 'outside-workspace'
  | 'stale-version'
  | 'too-large'
  | 'denied'
  | 'not-regular-file'
  | 'io-error'

/** Failure payload of one save call. */
export interface SaveFailure {
  readonly code: SaveFailureCode
  /** Host-side sentence for logs and the unknown-code fallback copy. */
  readonly message: string
  /** Path the call targeted, when the Host could determine it. */
  readonly path?: string
  /** Sandbox mode in force, for `denied`. */
  readonly mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Write cap in bytes, for `too-large`. */
  readonly limit?: number
  /** Current version on disk, for `stale-version`, when a stat could read it. */
  readonly currentVersion?: string
}

/** What a successful save reports back. */
export interface SaveValue {
  /** Absolute path of the written file in the filesystem's execution world. */
  readonly absolutePath: string
  /** Version after the write; the next save's CAS basis. */
  readonly version: string
  /** UTF-8 bytes written. */
  readonly bytes: number
}

/** Answer of one save call: the value, or the failure the browser renders. */
export type SaveResponse =
  | { readonly ok: true; readonly value: SaveValue }
  | { readonly ok: false; readonly error: SaveFailure }

/** Deployment facts the editor needs before it opens a file. */
export interface StateValue {
  /** Inclusive UTF-8 byte cap on one open-and-save round trip. */
  readonly maxWriteBytes: number
  /** Whether saves follow the Session's sandbox mode. */
  readonly respectSessionMode: boolean
}

/** Answer of the state route. */
export type StateResponse =
  | { readonly ok: true; readonly value: StateValue }
  | { readonly ok: false; readonly error: SaveFailure }

/** One declaration file the editor hands to Monaco as an ambient library. */
export interface TypeLibrary {
  /** Absolute path on the Host; the browser derives a `file://` URI from it. */
  readonly path: string
  /** Complete declaration text. */
  readonly text: string
}

/**
 * The project facts Monaco's TypeScript worker needs for one file.
 *
 * `options` mirrors the subset of `tsconfig.json` `compilerOptions` that
 * changes how completion resolves, with TypeScript's own enum names kept as
 * strings (the browser maps them onto Monaco's enums). `libraries` carries the
 * `.d.ts` closure of what the file imports, so library types — React above all
 * — take part in completion.
 */
export interface TypePayload {
  /** Path the payload was collected for, echoed for the browser's cache key. */
  readonly path: string
  /** `tsconfig.json` `compilerOptions`, reduced to names Monaco understands. */
  readonly options: Readonly<Record<string, string | number | boolean | readonly string[]>>
  /** Declaration closure, already de-duplicated and size-bounded. */
  readonly libraries: readonly TypeLibrary[]
  /** Non-fatal notes for the editor's status line (missing tsconfig, truncated closure). */
  readonly notes: readonly string[]
}

/** Answer of the types route. */
export type TypesResponse =
  | { readonly ok: true; readonly value: TypePayload }
  | { readonly ok: false; readonly error: SaveFailure }
