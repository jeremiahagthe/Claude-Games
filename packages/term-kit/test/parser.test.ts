import { describe, expect, it } from 'vitest'
import { KeyParser } from '../src/input/parser.js'

// Case preservation across BOTH input paths — chess SAN needs it ('Nf3' has
// an uppercase piece letter; lowercase 'nf3' names nothing). The fragwait
// original lowercased everywhere (WASD controls are case-insensitive);
// checkwait's copy must not.

describe('KeyParser case preservation (plain bytes)', () => {
  it('preserves an uppercase printable byte', () => {
    const p = new KeyParser()
    expect(p.feed('N')).toEqual([{ key: 'N', kind: 'press' }])
  })

  it('still delivers lowercase bytes as-is', () => {
    const p = new KeyParser()
    expect(p.feed('n')).toEqual([{ key: 'n', kind: 'press' }])
  })
})

describe('KeyParser case preservation (kitty CSI-u path)', () => {
  // iTerm2 negotiates kitty mode (TerminalSession requests ESC[>2u), so on
  // the feel-gate terminal every keystroke can arrive via CSI-u. The kitty
  // spec allows a shifted letter to arrive in several shapes; all must
  // decode to 'N'.

  it('applies the shift modifier to a lowercase codepoint: CSI 110;2u -> N', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[110;2u')).toEqual([{ key: 'N', kind: 'press' }])
  })

  it('preserves an already-shifted codepoint: CSI 78;2u -> N (must NOT lowercase)', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[78;2u')).toEqual([{ key: 'N', kind: 'press' }])
  })

  it('prefers the shifted-key alternate when reported: CSI 110:78;2u -> N', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[110:78;2u')).toEqual([{ key: 'N', kind: 'press' }])
  })

  it('unshifted codepoint with no modifiers stays lowercase: CSI 110u -> n', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[110u')).toEqual([{ key: 'n', kind: 'press' }])
  })

  it('shift does not mangle non-letter codepoints: CSI 61;2u (shift+=) stays =', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[61;2u')).toEqual([{ key: '=', kind: 'press' }])
  })

  it('event kinds still decode alongside case: CSI 110;2:3u is an N release', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[110;2:3u')).toEqual([{ key: 'N', kind: 'release' }])
  })

  it('named keys are unaffected: CSI 13;2u is still enter', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[13;2u')).toEqual([{ key: 'enter', kind: 'press' }])
  })
})
