/**
 * The one place the browser touches the Host's read-only file Remote namespace.
 *
 * `ctx.remote.workspaceFiles` is generated from the Host package's Typert
 * artifact. This bundle is built outside the harness, where that artifact's
 * `.d.ts` does not exist, so the shape is restated here against the public
 * `WorkspaceFileBytes` type — the one call the editor makes, typed as the Host
 * promises it. Keeping the assertion in one adapter means a Host-side signature
 * change surfaces as a type error here rather than silently mistyping callers.
 *
 * @module dsh-explorer-editor/client/remote
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceByteReadOptions, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The `workspaceFiles` methods this plugin consumes. */
export interface WorkspaceFilesRemote {
  /**
   * Read a complete regular file's bytes with the version at the preceding stat.
   * @param sessionId - Session whose workspace a relative path resolves against.
   * @param path - absolute path, or one relative to the workspace root.
   * @param options - base file and byte range; empty reads the whole file.
   * @param signal - caller cancellation.
   * @returns the bytes and version, or the Host's failure.
   */
  readBytes(
    sessionId: SessionId,
    path: string,
    options: WorkspaceByteReadOptions,
    signal: AbortSignal,
  ): Promise<RemoteResult<WorkspaceFileBytes>>
}

/**
 * Read the `workspaceFiles` namespace off the client remote.
 * @param ctx - client context.
 * @returns the namespace as this plugin consumes it.
 */
export function workspaceFiles(ctx: Context): WorkspaceFilesRemote {
  return (ctx as unknown as { remote: { workspaceFiles: WorkspaceFilesRemote } }).remote.workspaceFiles
}
