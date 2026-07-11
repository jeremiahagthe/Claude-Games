import { describe, expect, it } from 'vitest'
import { detectColorMode, viewSize } from '../src/caps.js'

describe('caps', () => {
  it('COLORTERM=truecolor → truecolor', () =>
    expect(detectColorMode({ COLORTERM: 'truecolor' })).toBe('truecolor'))
  it('Apple Terminal (no COLORTERM, TERM_PROGRAM=Apple_Terminal) → not truecolor', () =>
    expect(detectColorMode({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' })).not.toBe('truecolor'))
  it('viewSize clamps to sane minimums', () => {
    const v = viewSize(80, 24)
    expect(v.viewCols).toBeGreaterThan(0)
    expect(v.viewRows).toBeGreaterThan(0)
  })
})
