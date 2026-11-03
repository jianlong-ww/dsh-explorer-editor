/**
 * Identity of the browser face, kept apart from the wiring.
 *
 * The module table loads this bundle by its package name, and Cordis activates
 * it by the services named here; both are checked by a test that must not pull
 * React or the UI primitives in, so they live in their own module.
 *
 * @module dsh-explorer-editor/client/manifest
 */

/** Cordis plugin name; must equal the package name the module table registers. */
export const name = 'dsh-explorer-editor'

/**
 * Services required: the slot registry, copy, the preview renderer registry, and
 * the read-only file Remote namespace.
 *
 * `documentPreviews` is provided by the preview plugin, so injecting it both
 * orders activation after that plugin and makes a missing preview a stated
 * dependency rather than a runtime surprise.
 */
export const inject = ['slots', 'locale', 'documentPreviews', 'remote', 'remote.workspaceFiles']
