import { describe, expect, it } from 'vitest'
import { KeyParser } from '../src/input/parser.js'
import { createInputTranslator, type InputTranslatorOpts } from '../src/input/translate.js'
import type { SelectEvent } from '../src/select.js'

// Drives the shared raw-input → SelectEvent translation with REAL bytes
// through a real KeyParser (the exact wiring both game loops use), recording
// every hook call. This is the piece that must never drift between offline
// (game.ts) and online (online.ts) — one binding, one test.
function harness(overrides: Partial<InputTranslatorOpts> = {}) {
  const calls = {
    dispatched: [] as SelectEvent[],
    redraws: 0,
    quitRequests: 0,
    instantQuits: 0,
    bannerCleared: 0,
  }
  const parser = new KeyParser()
  const translator = createInputTranslator(parser, {
    dispatch: (e) => calls.dispatched.push(e),
    redraw: () => calls.redraws++,
    squareAt: (x, y) => (x >= 1 && x <= 48 && y >= 1 && y <= 24 ? 0 : null), // square a1 inside a fake board
    hasPendingPromotion: () => false,
    hasBanner: () => false,
    clearBanner: () => calls.bannerCleared++,
    quitArmed: () => false,
    requestQuit: () => calls.quitRequests++,
    instantQuit: () => calls.instantQuits++,
    ...overrides,
  })
  return { translator, calls }
}

describe('createInputTranslator', () => {
  it('accumulates typed move chars and dispatches typed on enter', () => {
    const { translator, calls } = harness()
    translator.onData(Buffer.from('e2e4'))
    expect(translator.typed).toBe('e2e4')
    translator.onData(Buffer.from('\r'))
    expect(calls.dispatched).toEqual([{ kind: 'typed', text: 'e2e4' }])
    expect(translator.typed).toBe('') // buffer consumed by submit
  })

  it('enter with an empty buffer dispatches the cursor-select enter event', () => {
    const { translator, calls } = harness()
    translator.onData(Buffer.from('\r'))
    expect(calls.dispatched).toEqual([{ kind: 'enter' }])
  })

  it('q with an empty buffer requests quit; q inside a typed move does not', () => {
    const { translator, calls } = harness()
    translator.onData(Buffer.from('q'))
    expect(calls.quitRequests).toBe(1)
    // Binding pinned since Task 9: any q/Q with an EMPTY buffer is a quit
    // request; a q/Q typed after another move char joins the buffer (so
    // promotions like 'e8=Q' can spell out the queen).
    translator.onData(Buffer.from('e8=Q'))
    expect(translator.typed).toBe('e8=Q')
    expect(calls.quitRequests).toBe(1) // the Q joined the buffer instead of quitting
  })

  it('ctrl-c always triggers instantQuit, never the confirm-gated path', () => {
    const { translator, calls } = harness()
    translator.onData(Buffer.from('\x03'))
    expect(calls.instantQuits).toBe(1)
    expect(calls.quitRequests).toBe(0)
  })

  it('esc clears an in-progress typed buffer before anything else', () => {
    const { translator, calls } = harness()
    translator.onData(Buffer.from('Nf3'))
    expect(translator.typed).toBe('Nf3')
    translator.onData(Buffer.from('\x1b'))
    translator.onData(Buffer.from('x')) // flush the lone-ESC wait with a next byte
    expect(translator.typed).toBe('x') // esc cleared 'Nf3'; 'x' started fresh
    expect(calls.quitRequests).toBe(0)
  })

  it('esc dismisses a live banner instead of arming quit', () => {
    let banner: string | null = 'Claude is done'
    const { translator, calls } = harness({
      hasBanner: () => banner !== null,
      clearBanner: () => { banner = null },
    })
    // A lone ESC is held by the parser until the next byte arrives (could be
    // the start of a CSI), so each press needs a following byte to flush.
    translator.onData(Buffer.from('\x1b'))
    translator.onData(Buffer.from('\x1b')) // flushes the first esc
    expect(banner).toBeNull() // first esc dismissed the banner, didn't arm quit
    expect(calls.quitRequests).toBe(0)
    translator.onData(Buffer.from(' ')) // flushes the second esc (space itself is ignored)
    expect(calls.quitRequests).toBe(1) // banner gone → esc now requests quit
  })

  it('arrow keys dispatch cursor moves', () => {
    const { translator, calls } = harness()
    translator.onData(Buffer.from('\x1b[A\x1b[D'))
    expect(calls.dispatched).toEqual([
      { kind: 'cursor', dir: 'up' },
      { kind: 'cursor', dir: 'left' },
    ])
  })

  it('promotion keys route to promo while a promotion is pending', () => {
    const { translator, calls } = harness({ hasPendingPromotion: () => true })
    translator.onData(Buffer.from('n'))
    expect(calls.dispatched).toEqual([{ kind: 'promo', piece: 'n' }])
  })

  it('backspace trims the typed buffer', () => {
    const { translator } = harness()
    translator.onData(Buffer.from('e2e4'))
    // Backspace reaches the parser via the kitty CSI-u path (plain \x7f is a
    // swallowed control byte — pre-existing parser behavior).
    translator.onData(Buffer.from('\x1b[127u'))
    expect(translator.typed).toBe('e2e')
  })

  it('caps the typed buffer at 10 chars', () => {
    const { translator } = harness()
    translator.onData(Buffer.from('e2e4e2e4e2e4'))
    expect(translator.typed).toHaveLength(10)
  })

  it('left mouse press inside the board dispatches a click', () => {
    const { translator, calls } = harness()
    translator.onData(Buffer.from('\x1b[<0;5;5M')) // SGR left press at (5,5)
    expect(calls.dispatched).toEqual([{ kind: 'click', square: 0 }])
  })

  it('inputLocked blocks board input (typing/cursor/enter) but never quit', () => {
    const { translator, calls } = harness({ inputLocked: () => true })
    translator.onData(Buffer.from('e2e4\r'))
    translator.onData(Buffer.from('\x1b[A'))
    expect(translator.typed).toBe('')
    expect(calls.dispatched).toEqual([])
    translator.onData(Buffer.from('q'))
    expect(calls.quitRequests).toBe(1) // resign must always be reachable mid-send
    translator.onData(Buffer.from('\x03'))
    expect(calls.instantQuits).toBe(1)
  })
})
