/**
 * Test runner for the two faces.
 *
 * The tests import the plugin sources directly. Outside the harness those
 * sources' `@deepseek-ai/*` dependencies have no build output, so the two the
 * runtime actually executes — the config schema library and the client store
 * engine — are aliased to a local harness checkout. Everything else the tests
 * touch is type-only or faked.
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const harness = resolve(import.meta.dirname, '..', 'deepseek-harness')

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/schemastery': resolve(harness, 'vendor/schemastery/src/index.ts'),
      '@deepseek-ai/cosmokit': resolve(harness, 'vendor/cosmokit/src/index.ts'),
      '@deepseek-ai/dsh-client-store': resolve(harness, 'packages/client/store/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
