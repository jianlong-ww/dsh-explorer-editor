import { defineConfig } from 'tsdown'

/**
 * Two outputs from one package:
 *
 * - `lib/index.js` — the Host plugin, ESM for the Loader. Every
 *   `@deepseek-ai/*` import stays external: the Host already has those
 *   packages, and a second copy of `dsh-fs` would break the brand and error
 *   checks the filesystem relies on.
 * - `lib/client.js` — the browser plugin, wrapped in the module-table handoff
 *   `window.__ModuleLoader__.load({ id, factory })`. The id is the package
 *   name. Anything the page already supplies (the platform seeds: React, the
 *   UI primitives, the slot registry, the store engine) stays external and is
 *   resolved through the factory's `require`.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    deps: {
      neverBundle: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        '@deepseek-ai/cordis',
        '@deepseek-ai/schemastery',
        'zod',
        '@deepseek-ai/dsh-client-store',
        '@deepseek-ai/dsh-client-ui-slots',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-explorer-editor", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
