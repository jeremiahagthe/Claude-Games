// Shared game loop: TerminalSession enter, input parsing, selectStep, local
// applyMove + tickClock, redraw, Claude listener banner, quit confirm, end
// screen, share card. Task 9 wires this to a synchronous bot opponent
// (offline.ts). Task 10's online flow (online.ts) grows its own thin shell
// around the same selectStep/render/quit/dismiss/share building blocks
// instead of reusing runGame verbatim — its moves are server-relay events
// rather than a synchronous local apply, so the loop bodies genuinely
// differ (see task-9-report.md for the original scope call, task-10-report.md
// for why online didn't fold into this function).
import type { ChessDifficulty, ChessState, Color, Move, Result } from 'checkwait-core'
import { DIFFICULTY_BUDGETS, applyMove, bestMove, initialState, legalMoves, tickClock, toSAN } from 'checkwait-core'
import { cellToSquare, renderBoard } from './board-render.js'
import { detectColorMode } from './caps.js'
import { startClaudeListener } from './claude.js'
import { waitForPress } from './input/dismiss.js'
import { KeyParser } from './input/parser.js'
import { QuitConfirm } from './input/quit.js'
import { INITIAL_SELECT_STATE, selectStep, type SelectEvent, type SelectState } from './select.js'
import { shareCard } from './share.js'
import { TerminalSession } from './terminal.js'

const REDRAW_MS = 100 // 10fps
const TYPED_BUFFER_MAX = 10
// Characters a SAN/coordinate move can legally contain: files a-h, ranks
// 1-8, piece letters, capture/promotion/check punctuation, and castling's
// '-' and 'O'.
const MOVE_CHARS = /^[a-hA-H1-8KQRBNOx=+#-]$/

export interface GameOpts {
  selfColor: Color
  difficulty: ChessDifficulty
  opponentHandle: string // e.g. 'bot·easy' offline — caller's call (Task 9)
  seed?: number
}

// Exported for online.ts's own finished-game screen (Task 10) — same
// win/loss/draw phrasing offline and online.
export function resultLine(result: Result, selfColor: Color): string {
  if ('winner' in result) {
    const you = result.winner === selfColor
    const reason = result.kind === 'flag' ? 'on time' : result.kind === 'checkmate' ? 'by checkmate' : 'by resignation'
    return you ? `you won ${reason}` : `you lost ${reason}`
  }
  const REASONS: Record<Exclude<Result['kind'], 'checkmate' | 'resign' | 'flag'>, string> = {
    stalemate: 'stalemate',
    'fifty-move': 'the fifty-move rule',
    threefold: 'threefold repetition',
    insufficient: 'insufficient material',
  }
  return `draw by ${REASONS[result.kind as Exclude<Result['kind'], 'checkmate' | 'resign' | 'flag'>]}`
}

export async function runGame(opts: GameOpts): Promise<void> {
  const term = new TerminalSession(process.stdin, process.stdout)
  const parser = new KeyParser()
  const quitConfirm = new QuitConfirm(() => performance.now())
  const colorMode = detectColorMode(process.env) === 'truecolor' ? 'truecolor' : 'basic'

  let cols = process.stdout.columns ?? 80
  let rows = process.stdout.rows ?? 24
  let sel: SelectState = INITIAL_SELECT_STATE
  let state: ChessState = initialState()
  let lastMove: Move | null = null
  const sanHistory: string[] = []
  let banner: string | null = null
  let typedBuffer = ''
  let quit = false
  let lastTickAt = performance.now()
  let seed = (opts.seed ?? Date.now()) >>> 0

  function tick(): void {
    const now = performance.now()
    const dt = now - lastTickAt
    lastTickAt = now
    if (!state.result) state = tickClock(state, dt)
  }

  // Applies the player's move (SAN captured BEFORE applyMove, per contract),
  // then — if the game isn't over — computes and applies the bot's reply
  // synchronously (the node budget keeps this snappy).
  function afterMove(move: Move): void {
    tick()
    if (state.result) return
    const san = toSAN(state, move)
    state = applyMove(state, move)
    sanHistory.push(san)
    lastMove = move
    if (state.result) return

    if (state.turn !== opts.selfColor) {
      tick()
      if (state.result) return
      const botMove = bestMove(state, DIFFICULTY_BUDGETS[opts.difficulty], seed++)
      // Charge the bot's synchronous think time to the BOT's clock: without
      // this tick, the next interval tick would land after applyMove flips
      // the turn, silently billing the bot's search time to the player. If
      // the bot flags while "thinking", the game ends here and the move is
      // discarded (tickClock stamps the flag result).
      tick()
      if (state.result) return
      const botSan = toSAN(state, botMove)
      state = applyMove(state, botMove)
      sanHistory.push(botSan)
      lastMove = botMove
    }
  }

  function dispatch(e: SelectEvent): void {
    const { sel: nextSel, move } = selectStep(state, sel, e, opts.selfColor)
    sel = nextSel
    if (move) afterMove(move)
    redraw()
  }

  function currentStatusLine(): string {
    if (quitConfirm.armed) return 'press again to quit'
    if (sel.pendingPromotion) return 'promote: (q)ueen (r)ook (b)ishop k(n)ight'
    if (banner) return banner
    if (typedBuffer.length > 0) return `> ${typedBuffer}`
    return ''
  }

  function redraw(): void {
    const legalTargets =
      sel.selected === null ? [] : legalMoves(state).filter((m) => m.from === sel.selected).map((m) => m.to)
    term.write(
      renderBoard({
        state,
        selfColor: opts.selfColor,
        selected: sel.selected,
        legalTargets,
        lastMove,
        cursor: sel.cursor,
        colorMode,
        cols,
        rows,
        sanHistory,
        opponentHandle: opts.opponentHandle,
        statusLine: currentStatusLine(),
      }),
    )
  }

  const listener = await startClaudeListener()
  listener.onEvent((event) => {
    // Unlike fragwait's FPS loop, Enter is already claimed by chess's core
    // cursor-select/typed-move-submit gameplay action, so it can't double as
    // a banner "quit & return" shortcut here — Esc dismisses instead (Esc is
    // otherwise only a typed-buffer-clear / quit-confirm arm, both harmless
    // to overload with "also dismiss the banner").
    banner = event === 'done' ? '✔ Claude is done (Esc to dismiss)' : '⚠ Claude needs your input (Esc to dismiss)'
  })

  const onResize = () => {
    cols = process.stdout.columns ?? 80
    rows = process.stdout.rows ?? 24
    redraw()
  }
  process.stdout.on('resize', onResize)

  const onData = (chunk: Buffer) => {
    for (const e of parser.feed(chunk)) {
      if ('type' in e) {
        if (e.action === 'press' && e.button === 'left') {
          const square = cellToSquare(e.x, e.y, cols, rows, opts.selfColor)
          if (square !== null) dispatch({ kind: 'click', square })
        }
        continue
      }
      if (e.kind !== 'press') continue // repeats/releases never drive game input
      const key = e.key
      const lower = key.toLowerCase()

      if (lower === 'ctrl-c') { quit = true; continue } // instant escape hatch, never confirm-gated

      if (sel.pendingPromotion && (lower === 'q' || lower === 'r' || lower === 'b' || lower === 'n')) {
        dispatch({ kind: 'promo', piece: lower as 'q' | 'r' | 'b' | 'n' })
        continue
      }

      if (lower === 'esc') {
        if (typedBuffer.length > 0) { typedBuffer = ''; redraw(); continue }
        if (banner && !quitConfirm.armed) { banner = null; redraw(); continue }
        quit = quitConfirm.request()
        redraw()
        continue
      }
      // 'q' quits only when there's no typed buffer in progress — a typed
      // queen move ('Qxf7') must be able to use the letter q/Q.
      if (lower === 'q' && typedBuffer.length === 0) {
        quit = quitConfirm.request()
        redraw()
        continue
      }
      if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
        dispatch({ kind: 'cursor', dir: key })
        continue
      }
      if (lower === 'enter') {
        if (typedBuffer.length > 0) {
          const text = typedBuffer
          typedBuffer = ''
          dispatch({ kind: 'typed', text })
        } else {
          dispatch({ kind: 'enter' })
        }
        continue
      }
      if (lower === 'backspace') {
        typedBuffer = typedBuffer.slice(0, -1)
        redraw()
        continue
      }
      if (MOVE_CHARS.test(key) && typedBuffer.length < TYPED_BUFFER_MAX) {
        typedBuffer += key
        redraw()
      }
    }
  }
  process.stdin.on('data', onData)

  term.enter()
  term.installExitGuards(() => { /* no extra resources to release offline */ })
  redraw()

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      tick()
      if (quit || state.result) {
        clearInterval(timer)
        resolve()
        return
      }
      redraw()
    }, REDRAW_MS)
  })

  process.stdin.off('data', onData)
  process.stdout.off('resize', onResize)

  const finished = state.result !== null
  if (finished) {
    term.write(
      renderBoard({
        state,
        selfColor: opts.selfColor,
        selected: null,
        legalTargets: [],
        lastMove,
        cursor: null,
        colorMode,
        cols,
        rows,
        sanHistory,
        opponentHandle: opts.opponentHandle,
        statusLine: `${resultLine(state.result!, opts.selfColor)} — press any key`,
      }),
    )
    await waitForPress(process.stdin, parser)
  }

  await listener.close()
  term.restore()
  // Share card on the NORMAL screen (post-restore) so it lands in scrollback.
  // Finished games only — a mid-match quit has no result worth sharing.
  if (finished) {
    process.stdout.write('\n' + shareCard(state.result!, opts.selfColor, sanHistory.length, opts.opponentHandle))
  }
  process.exit(0)
}
