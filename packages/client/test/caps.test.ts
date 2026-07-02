import { describe, expect, it } from 'vitest'
import { detectColorMode, viewSize } from '../src/caps.js'

describe('detectColorMode', () => {
  it('COLORTERM=truecolor wins', () => {
    expect(detectColorMode({ COLORTERM: 'truecolor', TERM: 'xterm-256color' })).toBe('truecolor')
  })
  it('Apple_Terminal is 256 even with COLORTERM unset', () => {
    expect(detectColorMode({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' })).toBe('256')
  })
  it('TERM=dumb is mono', () => {
    expect(detectColorMode({ TERM: 'dumb' })).toBe('mono')
  })
  it('plain xterm falls back to 256', () => {
    expect(detectColorMode({ TERM: 'xterm' })).toBe('256')
  })
})

describe('viewSize', () => {
  it('reserves 3 HUD rows and clamps minimums', () => {
    expect(viewSize(120, 40)).toEqual({ viewCols: 120, viewRows: 37 })
    expect(viewSize(10, 5)).toEqual({ viewCols: 40, viewRows: 12 })
  })
})
