// Shared raw-input → game-action translation for BOTH game loops (offline
// game.ts and online online.ts). The two loops genuinely differ in how a move
// is APPLIED (synchronous local bot vs. server relay), but the key/mouse
// bindings are identical by design — extracting them here keeps a binding
// change from silently drifting between the two files. The only online-shaped
// seam is `inputLocked` (move in flight, board input suspended), which
// offline simply omits.
import type { SelectEvent } from '../select.js'
import type { KeyParser } from './parser.js'

export const TYPED_BUFFER_MAX = 10
// Characters a SAN/coordinate move can legally contain: files a-h, ranks
// 1-8, piece letters, capture/promotion/check punctuation, and castling's
// '-' and 'O'.
export const MOVE_CHARS = /^[a-hA-H1-8KQRBNOx=+#-]$/

export interface InputTranslatorOpts {
  dispatch(e: SelectEvent): void
  redraw(): void
  // Board-square lookup for a 1-based terminal mouse coordinate (null =
  // outside the board). The caller closes over cols/rows/selfColor.
  squareAt(x: number, y: number): number | null
  hasPendingPromotion(): boolean
  hasBanner(): boolean
  clearBanner(): void
  quitArmed(): boolean
  // Q/Esc quit-intent press — the caller owns the QuitConfirm gating and the
  // resulting redraw (both loops do `quit = quitConfirm.request(); redraw()`).
  requestQuit(): void
  instantQuit(): void // ctrl-c: never confirm-gated
  // Online: true while the player's own move is in flight (unacked). Blocks
  // board input (cursor/enter/typing) but NEVER quit — the player must always
  // be able to resign, even mid-send.
  inputLocked?(): boolean
}

export interface InputTranslator {
  onData(chunk: Buffer): void
  readonly typed: string // in-progress typed move, for the status line
}

export function createInputTranslator(parser: KeyParser, o: InputTranslatorOpts): InputTranslator {
  let typedBuffer = ''
  return {
    get typed() {
      return typedBuffer
    },
    onData(chunk: Buffer): void {
      for (const e of parser.feed(chunk)) {
        if ('type' in e) {
          if (e.action === 'press' && e.button === 'left') {
            const square = o.squareAt(e.x, e.y)
            if (square !== null) o.dispatch({ kind: 'click', square })
          }
          continue
        }
        if (e.kind !== 'press') continue // repeats/releases never drive game input
        const key = e.key
        const lower = key.toLowerCase()

        if (lower === 'ctrl-c') {
          o.instantQuit()
          continue
        }

        if (o.hasPendingPromotion() && (lower === 'q' || lower === 'r' || lower === 'b' || lower === 'n')) {
          o.dispatch({ kind: 'promo', piece: lower as 'q' | 'r' | 'b' | 'n' })
          continue
        }

        if (lower === 'esc') {
          if (typedBuffer.length > 0) {
            typedBuffer = ''
            o.redraw()
            continue
          }
          if (o.hasBanner() && !o.quitArmed()) {
            o.clearBanner()
            o.redraw()
            continue
          }
          o.requestQuit()
          continue
        }
        // 'q' quits only when there's no typed buffer in progress — a typed
        // queen move ('Qxf7') must be able to use the letter q/Q.
        if (lower === 'q' && typedBuffer.length === 0) {
          o.requestQuit()
          continue
        }
        if (o.inputLocked?.()) continue // move in flight: no board input until it's acked

        if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
          o.dispatch({ kind: 'cursor', dir: key })
          continue
        }
        if (lower === 'enter') {
          if (typedBuffer.length > 0) {
            const text = typedBuffer
            typedBuffer = ''
            o.dispatch({ kind: 'typed', text })
          } else {
            o.dispatch({ kind: 'enter' })
          }
          continue
        }
        if (lower === 'backspace') {
          typedBuffer = typedBuffer.slice(0, -1)
          o.redraw()
          continue
        }
        if (MOVE_CHARS.test(key) && typedBuffer.length < TYPED_BUFFER_MAX) {
          typedBuffer += key
          o.redraw()
        }
      }
    },
  }
}
