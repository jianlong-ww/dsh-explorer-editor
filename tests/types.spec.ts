/**
 * Type-resolver tests against a real fixture tree.
 *
 * The resolver is the difference between "the editor completes the file's own
 * variables" and "the editor completes React's API", so what matters is that it
 * finds a package's declaration file through `package.json`, follows that
 * declaration's own imports, and picks up the project's `tsconfig` options.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { collectTypes } from '../src/type-resolver.ts'

/** A workspace with a tsconfig, a source file, and a stubbed React typings package. */
const root = mkdtempSync(join(tmpdir(), 'dsh-types-'))

/** Write one file, creating parents. */
function write(path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

write('tsconfig.json', `{
  // comments are legal here, and so are trailing commas
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
  },
}`)
write('node_modules/@types/react/package.json', JSON.stringify({ name: '@types/react', types: 'index.d.ts' }))
write('node_modules/@types/react/index.d.ts', `
import * as CSS from 'csstype'
export declare function useState<T>(initial: T): [T, (next: T) => void]
export declare const Fragment: unknown
`)
write('node_modules/csstype/package.json', JSON.stringify({ name: 'csstype', types: 'index.d.ts' }))
write('node_modules/csstype/index.d.ts', 'export type Property = string\n')
write('src/App.tsx', `
import { useState } from 'react'
export function App() {
  const [count] = useState(0)
  return count
}
`)

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('collectTypes', () => {
  it('lifts the project compiler options', () => {
    const payload = collectTypes(join(root, 'src/App.tsx'))
    expect(payload.options).toMatchObject({
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
    })
  })

  it('resolves the import to its declaration file and follows it', () => {
    const payload = collectTypes(join(root, 'src/App.tsx'))
    const paths = payload.libraries.map(library => library.path.replaceAll('\\', '/'))
    expect(paths.some(path => path.endsWith('@types/react/index.d.ts'))).toBe(true)
    // The closure reaches React's own import of csstype.
    expect(paths.some(path => path.endsWith('csstype/index.d.ts'))).toBe(true)
    const react = payload.libraries.find(library => library.path.includes('@types'))
    expect(react?.text).toContain('useState')
  })

  it('reports the file path it collected for', () => {
    const payload = collectTypes(join(root, 'src/App.tsx'))
    expect(payload.path.replaceAll('\\', '/').endsWith('src/App.tsx')).toBe(true)
  })

  it('notes an unresolvable dependency as one aggregate line', () => {
    write('src/Broken.ts', `import { thing } from 'not-installed'\nimport { other } from 'also-missing'\n`)
    const payload = collectTypes(join(root, 'src/Broken.ts'))
    expect(payload.notes.some(note => note.includes('2 imported module(s)'))).toBe(true)
    expect(payload.libraries).toEqual([])
  })

  it('falls back to React-friendly defaults without a tsconfig', () => {
    // A sibling temp tree, so the fixture's tsconfig above `root` stays out of reach.
    const bare = mkdtempSync(join(tmpdir(), 'dsh-types-bare-'))
    try {
      writeFileSync(join(bare, 'a.ts'), 'export const a = 1\n')
      const payload = collectTypes(join(bare, 'a.ts'))
      expect(payload.options).toMatchObject({ jsx: 'react-jsx', moduleResolution: 'bundler', strict: true })
      expect(payload.notes.some(note => note.includes('tsconfig'))).toBe(true)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
