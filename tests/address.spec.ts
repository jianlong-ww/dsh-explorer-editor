/**
 * Address and language tests: the tab address is the only place the body learns
 * which file it edits, so both of its shapes and every suffix mapping are pinned.
 */
import { describe, expect, it } from 'vitest'
import { languageOf, parseFileAddress } from '../src/client/address.ts'

describe('parseFileAddress', () => {
  it('reads a session address', () => {
    expect(parseFileAddress('dsh-resource://file/session/s-1/src/App.tsx'))
      .toEqual({ sessionId: 's-1', path: 'src/App.tsx' })
  })

  it('keeps an absolute Windows path whole', () => {
    expect(parseFileAddress('dsh-resource://file/absolute/C:/work/repo/src/main.ts'))
      .toEqual({ sessionId: undefined, path: 'C:/work/repo/src/main.ts' })
  })

  it('decodes percent-encoded segments', () => {
    expect(parseFileAddress('dsh-resource://file/session/s-1/my%20notes/a.ts'))
      .toEqual({ sessionId: 's-1', path: 'my notes/a.ts' })
  })

  it('rejects addresses that are not file addresses', () => {
    expect(parseFileAddress('dsh-resource://chat/session/s-1')).toBeUndefined()
    expect(parseFileAddress('not a url')).toBeUndefined()
    expect(parseFileAddress('dsh-resource://file/session/s-1')).toBeUndefined()
    expect(parseFileAddress('dsh-resource://file/absolute')).toBeUndefined()
  })
})

describe('languageOf', () => {
  it('maps the suffixes the editor claims', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['src/App.tsx', 'typescript'],
      ['lib/a.mts', 'typescript'],
      ['src/main.ts', 'typescript'],
      ['src/main.js', 'javascript'],
      ['src/App.jsx', 'javascript'],
      ['package.json', 'json'],
      ['styles/site.scss', 'scss'],
      ['styles/site.less', 'less'],
      ['index.html', 'html'],
      ['docs/guide.md', 'markdown'],
      ['Notes.MD', 'markdown'],
      ['conf/settings.yml', 'yaml'],
      ['scripts/deploy.sh', 'shell'],
      ['src/main.py', 'python'],
      ['notes.txt', 'plaintext'],
      ['README', 'plaintext'],
    ]
    for (const [path, language] of cases) expect(languageOf(path)).toBe(language)
  })
})
