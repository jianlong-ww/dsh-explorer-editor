/**
 * Browser-side file reading for the editor.
 *
 * Reading goes through the Host's existing read-only `workspaceFiles` Remote
 * namespace, never through the save endpoint: the editor must start from the
 * exact bytes on disk and the version those bytes carried, and `readBytes` is
 * the one call that returns both. The paged `read` is deliberately not used —
 * it strips line terminators, so a file ending in a newline would lose it on a
 * round trip.
 *
 * @module dsh-explorer-editor/client/read
 */
import type { Context } from '@deepseek-ai/cordis'
import { workspaceFiles } from './remote.ts'
import type { ReadOutcome } from './outcome.ts'

/** The byte text never carries; its presence marks the file as binary. */
const NUL = String.fromCharCode(0)

/** Strict UTF-8 with the BOM kept in the text, so a round trip is byte-identical. */
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Classify a failed Remote call.
 * @param code - the Host's error code.
 * @param message - the Host's sentence.
 * @returns the failure the dialog renders.
 */
function failureOf(code: string, message: string): ReadOutcome {
  switch (code) {
    case 'workspace-file/too-large':
      return { ok: false, failure: { code: 'too-large', message } }
    case 'workspace-file/not-text':
      return { ok: false, failure: { code: 'not-text', message } }
    case 'workspace-file/not-found':
      return { ok: false, failure: { code: 'not-found', message } }
    case 'workspace-file/not-regular-file':
      return { ok: false, failure: { code: 'not-regular-file', message } }
    default:
      return { ok: false, failure: { code: 'read-failed', message } }
  }
}

/**
 * Read one file's complete text and version.
 * @param ctx - client context carrying the `workspaceFiles` Remote namespace.
 * @param sessionId - Session whose workspace the path resolves against.
 * @param path - target path, as the file tree names it.
 * @param signal - caller cancellation.
 * @returns the decoded text with its version, or the failure to render.
 */
export async function readEditableFile(
  ctx: Context,
  sessionId: string,
  path: string,
  signal: AbortSignal,
): Promise<ReadOutcome> {
  let result
  try {
    result = await workspaceFiles(ctx).readBytes(sessionId as never, path, {}, signal)
  } catch (error: unknown) {
    if (signal.aborted) throw error
    return {
      ok: false,
      failure: { code: 'read-failed', message: error instanceof Error ? error.message : String(error) },
    }
  }
  if (!result.ok) return failureOf(result.error.code, result.error.message)
  const bytes = result.value.data
  if (bytes.indexOf(0) !== -1) {
    return { ok: false, failure: { code: 'binary', message: `"${path}" contains NUL bytes` } }
  }
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return { ok: false, failure: { code: 'not-text', message: `"${path}" is not UTF-8 text` } }
  }
  // Decoding a lone NUL is legal; the file is still not editable text.
  if (text.includes(NUL)) {
    return { ok: false, failure: { code: 'binary', message: `"${path}" contains NUL bytes` } }
  }
  return { ok: true, value: { text, version: result.value.version, bytes: bytes.byteLength } }
}
