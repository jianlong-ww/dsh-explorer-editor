/**
 * Browser-side result shapes.
 *
 * The editor has three effects — read the file, save it, fetch project types —
 * and every one of them folds its failure into the same rendered form, so the
 * component branches on one model instead of three.
 *
 * @module dsh-explorer-editor/client/outcome
 */
import type { SaveValue } from '../protocol.ts'

/** Failure codes the browser renders: the Host's wire codes plus browser-only ones. */
export type ClientFailureCode =
  | 'bad-request'
  | 'not-found'
  | 'outside-workspace'
  | 'stale-version'
  | 'too-large'
  | 'denied'
  | 'not-regular-file'
  | 'io-error'
  | 'not-text'
  | 'binary'
  | 'read-failed'
  | 'offline'
  | 'http'
  | 'editor-load'

/** One rendered failure. */
export interface EditorFailure {
  readonly code: ClientFailureCode
  /** Host sentence; kept for the log and for failures without their own copy. */
  readonly message: string
  /** HTTP status when the failure came from the transport. */
  readonly status?: number
  /** Size cap in bytes, for `too-large`. */
  readonly limit?: number
  /** Version now on disk, for `stale-version`, when the Host reported one. */
  readonly currentVersion?: string
}

/** A completed file read. */
export interface ReadValue {
  readonly text: string
  readonly version: string
  readonly bytes: number
}

/** A file read the editor can render. */
export type ReadOutcome =
  | { readonly ok: true; readonly value: ReadValue }
  | { readonly ok: false; readonly failure: EditorFailure }

/** A save attempt, already folded into what the editor shows. */
export type SaveOutcome =
  | { readonly ok: true; readonly value: SaveValue }
  | { readonly ok: false; readonly failure: EditorFailure }
