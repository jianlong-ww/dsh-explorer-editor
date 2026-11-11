import { describe, expect, it } from 'vitest'
import { releaseAmdMarker } from '../src/client/monaco.ts'

// Monaco's AMD loader publishes `define.amd` on the page. UMD bundles test that
// marker before `module.exports` (the spreadsheet preview's `numeral` does), so
// leaving it set makes them register an anonymous AMD module and never assign
// their exports — which is how a CSV table ends up rendering black after the
// editor has been opened once.
describe('AMD marker release', () => {
  it('drops define.amd but keeps the define function installed', () => {
    const define = Object.assign(() => {}, { amd: { jQuery: true } })
    const target: { define?: { amd?: unknown } } = { define }
    releaseAmdMarker(target)
    expect(target.define).toBe(define)
    expect('amd' in define).toBe(false)
  })

  it('is safe on a page that never saw the loader', () => {
    const target: { define?: { amd?: unknown } } = {}
    expect(() => { releaseAmdMarker(target) }).not.toThrow()
  })

  it('is idempotent', () => {
    const define = Object.assign(() => {}, { amd: {} })
    const target = { define }
    releaseAmdMarker(target)
    releaseAmdMarker(target)
    expect(target.define).toBe(define)
    expect('amd' in define).toBe(false)
  })
})
