import { describe, expect, it } from 'vitest'
import { KeyParser } from '../src/input/parser.js'

describe('KeyParser', () => {
  it('plain chars are presses', () => {
    const p = new KeyParser()
    expect(p.feed('wasd ')).toEqual([
      { key: 'w', kind: 'press' },
      { key: 'a', kind: 'press' },
      { key: 's', kind: 'press' },
      { key: 'd', kind: 'press' },
      { key: ' ', kind: 'press' },
    ])
  })
  it('control keys', () => {
    const p = new KeyParser()
    expect(p.feed('\x03')).toEqual([{ key: 'ctrl-c', kind: 'press' }])
    expect(p.feed('\x0d')).toEqual([{ key: 'enter', kind: 'press' }])
    expect(p.feed('\x09')).toEqual([{ key: 'tab', kind: 'press' }])
  })
  it('legacy arrows', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[A\x1b[D')).toEqual([
      { key: 'up', kind: 'press' },
      { key: 'left', kind: 'press' },
    ])
  })
  it('kitty press/repeat/release for letters and space', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[97;1:1u')).toEqual([{ key: 'a', kind: 'press' }])
    expect(p.feed('\x1b[97;1:2u')).toEqual([{ key: 'a', kind: 'repeat' }])
    expect(p.feed('\x1b[97;1:3u')).toEqual([{ key: 'a', kind: 'release' }])
    expect(p.feed('\x1b[32;1:3u')).toEqual([{ key: ' ', kind: 'release' }])
  })
  it('kitty arrows with event types', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[1;1:3C')).toEqual([{ key: 'right', kind: 'release' }])
  })
  it('kitty support ack', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[?1u')).toEqual([{ key: 'kitty-ack', kind: 'press' }])
  })
  it('split sequences across feeds reassemble', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[9')).toEqual([])
    expect(p.feed('7;1:3u')).toEqual([{ key: 'a', kind: 'release' }])
  })
  it('unknown CSI is swallowed', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[38;2;1;2;3m')).toEqual([])
  })
  it('unterminated CSI garbage cannot grow the buffer or leak key events', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[' + '1;'.repeat(200))).toEqual([]) // capping feed leaks nothing
    expect(p.feed('w')).toEqual([{ key: 'w', kind: 'press' }]) // parser recovered
  })
  it('a large burst of valid input is fully parsed, not dropped by the cap', () => {
    const p = new KeyParser()
    const burst = '\x1b[97;1:1u\x1b[97;1:2u'.repeat(10) // 20 valid kitty events, ~200 bytes
    const events = p.feed(burst)
    expect(events).toHaveLength(20)
    expect(events.every((e) => e.key === 'a')).toBe(true)
  })
  it('SGR mouse press/release decode: left button, coordinates pass through as numbers', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[<0;10;20M')).toEqual([{ type: 'mouse', x: 10, y: 20, button: 'left', action: 'press' }])
    expect(p.feed('\x1b[<0;10;20m')).toEqual([{ type: 'mouse', x: 10, y: 20, button: 'left', action: 'release' }])
  })
  it('SGR motion decode: buttonless move (b=35 → none + motion bit), final M still reads as motion', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[<35;42;7M')).toEqual([{ type: 'mouse', x: 42, y: 7, button: 'none', action: 'motion' }])
  })
  it('wheel reports (b=64/65, ± motion bit) are swallowed — trackpad scroll must not become input', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[<64;10;10M')).toEqual([]) // wheel up
    expect(p.feed('\x1b[<65;10;10M')).toEqual([]) // wheel down
    expect(p.feed('\x1b[<96;10;10M')).toEqual([]) // wheel + motion bit (64+32)
  })
  it('malformed mouse reports are swallowed silently (never throw, never leak partial bytes)', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[<0;10M')).toEqual([]) // missing y field
    expect(p.feed('\x1b[<;;M')).toEqual([]) // empty (non-numeric) fields
    expect(p.feed('\x1b[<0;10;20;30M')).toEqual([]) // extra field
    expect(p.feed('w')).toEqual([{ key: 'w', kind: 'press' }]) // parser stays healthy
  })
  it('a key immediately following a mouse sequence in the same chunk still parses', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[<0;10;20Md')).toEqual([
      { type: 'mouse', x: 10, y: 20, button: 'left', action: 'press' },
      { key: 'd', kind: 'press' },
    ])
    expect(p.feed('w\x1b[<0;5;5m\x1b[A')).toEqual([
      { key: 'w', kind: 'press' },
      { type: 'mouse', x: 5, y: 5, button: 'left', action: 'release' },
      { key: 'up', kind: 'press' },
    ])
  })
  it('a mouse sequence split across feed() chunks reassembles and decodes, without corrupting the next key', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[<0;123;4')).toEqual([]) // partial: wait for more bytes
    expect(p.feed('5M' + 'd')).toEqual([
      { type: 'mouse', x: 123, y: 45, button: 'left', action: 'press' },
      { key: 'd', kind: 'press' },
    ])
  })
})
