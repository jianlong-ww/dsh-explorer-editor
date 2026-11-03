import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'
import * as client from '../src/client/manifest.ts'
import { MONACO_PREFIX, SAVE_ROUTE, STATE_ROUTE, TYPES_ROUTE } from '../src/protocol.ts'

/** Validate a Host config the way the Loader does: through the Standard Schema interface. */
const resolveConfig = (value: unknown) => host.Config['~standard'].validate(value).value

// The two faces are separate bundles with separate entry points; this only
// pins the surface the Loader and the module table read.
describe('plugin faces', () => {
  it('names the Host plugin after the package', () => {
    expect(host.name).toBe('dsh-explorer-editor')
  })

  it('declares the Host services it injects', () => {
    expect(host.inject).toEqual(['webServer', 'fs', 'sandboxPolicy', 'sessions'])
  })

  it('exposes a Host Config schema with the documented defaults', () => {
    expect(resolveConfig({})).toEqual({ maxWriteBytes: 2 * 1024 * 1024, respectSessionMode: true })
  })

  it('keeps an explicit config as given', () => {
    expect(resolveConfig({ maxWriteBytes: 4096, respectSessionMode: false }))
      .toEqual({ maxWriteBytes: 4096, respectSessionMode: false })
  })

  it('falls back to defaults for unusable values', () => {
    expect(resolveConfig({ maxWriteBytes: -1, respectSessionMode: 'yes' }))
      .toEqual({ maxWriteBytes: 2 * 1024 * 1024, respectSessionMode: true })
  })

  it('satisfies the Standard Schema contract the Loader calls', () => {
    expect(host.Config['~standard'].version).toBe(1)
    expect(typeof host.Config['~standard'].validate).toBe('function')
  })

  it('declares the Client services it injects', () => {
    expect(client.name).toBe('dsh-explorer-editor')
    expect(client.inject).toEqual(['slots', 'locale', 'documentPreviews', 'remote', 'remote.workspaceFiles'])
  })

  it('keeps every route under one prefix', () => {
    for (const route of [SAVE_ROUTE, STATE_ROUTE, TYPES_ROUTE]) {
      expect(route.startsWith('/explorer-editor/api/')).toBe(true)
    }
    expect(MONACO_PREFIX).toBe('/explorer-editor/monaco')
  })
})
