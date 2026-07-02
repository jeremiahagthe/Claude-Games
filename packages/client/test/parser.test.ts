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
})
