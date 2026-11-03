/**
 * Browser-side save transport.
 *
 * One `fetch` to the Host route, with the plugin's own header so the request is
 * neither a simple form post nor a same-origin GET a third party could ride.
 * The Host always answers with the wire contract from `protocol.ts`; this module
 * folds transport and framing failures into the same shape, so the store only
 * ever branches on one model.
 *
 * @module dsh-explorer-editor/client/save
 */
import {
  REQUEST_HEADER,
  SAVE_ROUTE,
  STATE_ROUTE,
  TYPES_ROUTE,
  type SaveFailure,
  type SaveRequest,
  type SaveResponse,
  type StateValue,
  type TypePayload,
} from '../protocol.ts'
import type { EditorFailure, SaveOutcome } from './outcome.ts'

/** Limit assumed when the deployment facts cannot be read; matches the Host default. */
export const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024

/**
 * Map a status the route answered without a parseable body.
 * @param status - HTTP status.
 * @returns the failure the dialog renders.
 */
function statusFailure(status: number): SaveOutcome {
  const code = status === 403
    ? 'denied'
    : status === 413
      ? 'too-large'
      : status === 409
        ? 'stale-version'
        : status === 404
          ? 'not-found'
          : 'http'
  return {
    ok: false,
    failure: { code, message: `save failed with HTTP ${String(status)}`, status },
  }
}

/**
 * Narrow the Host's wire failure onto what the dialog renders.
 * @param failure - the wire failure.
 * @returns the rendered failure.
 */
function rendered(failure: SaveFailure): EditorFailure {
  return {
    code: failure.code,
    message: failure.message,
    ...failure.limit === undefined ? {} : { limit: failure.limit },
    ...failure.currentVersion === undefined ? {} : { currentVersion: failure.currentVersion },
  }
}

/**
 * Post one save.
 * @param request - the file, its new text, and the version it was read at.
 * @param signal - caller cancellation.
 * @returns the Host's answer as a rendered outcome.
 */
export async function postSave(request: SaveRequest, signal: AbortSignal): Promise<SaveOutcome> {
  let response: Response
  try {
    response = await fetch(SAVE_ROUTE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [REQUEST_HEADER]: '1',
      },
      body: JSON.stringify(request),
      signal,
    })
  } catch (error: unknown) {
    if (signal.aborted) throw error
    return {
      ok: false,
      failure: { code: 'offline', message: error instanceof Error ? error.message : String(error) },
    }
  }
  let body: unknown
  try {
    body = await response.json() as unknown
  } catch {
    return statusFailure(response.status)
  }
  if (typeof body !== 'object' || body === null || !('ok' in body)) return statusFailure(response.status)
  const answer = body as SaveResponse
  if (answer.ok !== true) {
    const failure = answer.error
    if (typeof failure !== 'object' || failure === null) return statusFailure(response.status)
    return { ok: false, failure: rendered(failure) }
  }
  return response.ok ? answer : statusFailure(response.status)
}

/**
 * Read the deployment facts the editor needs, so the browser cap matches the
 * Host's instead of assuming one.
 * @param signal - caller cancellation.
 * @returns the deployment facts, or undefined when they cannot be read.
 */
export async function fetchDeploymentFacts(signal: AbortSignal): Promise<StateValue | undefined> {
  try {
    const response = await fetch(STATE_ROUTE, {
      method: 'GET',
      headers: { [REQUEST_HEADER]: '1' },
      signal,
    })
    if (!response.ok) return undefined
    const body = await response.json() as unknown
    if (typeof body !== 'object' || body === null || !('ok' in body)) return undefined
    const answer = body as { ok: unknown; value?: StateValue }
    return answer.ok === true && typeof answer.value === 'object' && answer.value !== null
      ? answer.value
      : undefined
  } catch (error: unknown) {
    if (signal.aborted) throw error
    return undefined
  }
}

/**
 * Fetch the project's declaration closure for one file.
 *
 * Types are an enhancement, not a precondition: a Host that cannot resolve them
 * still opens the file, and Monaco falls back to its own defaults, so this
 * never rejects — it returns undefined and the body notes the gap.
 * @param sessionId - Session whose workspace bounds the read.
 * @param path - the file being edited, as the tab address carried it.
 * @param signal - caller cancellation.
 * @returns the payload, or undefined when it could not be collected.
 */
export async function fetchTypes(
  sessionId: string,
  path: string,
  signal: AbortSignal,
): Promise<TypePayload | undefined> {
  const query = `path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId)}`
  try {
    const response = await fetch(`${TYPES_ROUTE}?${query}`, {
      method: 'GET',
      headers: { [REQUEST_HEADER]: '1' },
      signal,
    })
    if (!response.ok) return undefined
    const body = await response.json() as unknown
    if (typeof body !== 'object' || body === null || !('ok' in body)) return undefined
    const answer = body as { ok: unknown; value?: TypePayload }
    return answer.ok === true && typeof answer.value === 'object' && answer.value !== null
      ? answer.value
      : undefined
  } catch (error: unknown) {
    if (signal.aborted) throw error
    return undefined
  }
}
