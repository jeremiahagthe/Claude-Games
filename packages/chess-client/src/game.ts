// Offline game loop: TerminalSession enter, selectStep, local applyMove +
// tickClock, redraw, Claude listener banner, quit confirm, end screen, share
// card. Task 9 wires this to a synchronous bot opponent (offline.ts).
// Task 10's online flow (online.ts) keeps its own loop BODY (its moves are
// server-relay events rather than a synchronous local apply) but shares the
// parts that are identical by design: raw-input translation lives in
// input/translate.ts and the finished-screen/teardown tail is exported from
// here as teardownAndExit — change key bindings or the exit sequence in
// those shared spots, never per-loop.
import type { ChessDifficulty, ChessState, Color, Move, Result } from 'checkwait-core'
import { DIFFICULTY_BUDGETS, applyMove, bestMove, initialState, legalMoves, tickClock, toSAN } from 'checkwait-core'
import { cellToSquare, renderBoard } from './board-render.js'
import { detectColorMode, supportsDoubleSizePieces } from './caps.js'
import { startClaudeListener } from './claude.js'
import { waitForPress } from './input/dismiss.js'
import { KeyParser } from './input/parser.js'
import { QuitConfirm } from './input/quit.js'
import { createInputTranslator } from './input/translate.js'
import { INITIAL_SELECT_STATE, selectStep, type SelectEvent, type SelectState } from './select.js'
import { shareCard } from './share.js'
import { TerminalSession } from './terminal.js'

const REDRAW_MS = 100 // 10fps

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

// Shared tail for both loops: finished screen (if the game ended, not on a
// mid-match quit) → waitForPress → Claude-listener close → caller cleanup
// (e.g. online closes its socket) → terminal restore → share card on the
// NORMAL screen (post-restore, so it lands in scrollback ready to copy into
// a post) → exit.
export async function teardownAndExit(o: {
  term: TerminalSession
  parser: KeyParser
  listener: { close(): Promise<void> }
  finale: { screen: string; shareText: string } | null // null = quit mid-match, nothing worth showing
  beforeRestore?: () => void
}): Promise<never> {
  if (o.finale) {
    o.term.write(o.finale.screen)
    // M1: only a real key/button press dismisses — never mouse motion, focus
    // changes, or the release of a key held when the game ended.
    await waitForPress(process.stdin, o.parser)
  }
  await o.listener.close()
  o.beforeRestore?.()
  o.term.restore()
  if (o.finale) process.stdout.write('\n' + o.finale.shareText)
  process.exit(0)
}

export async function runGame(opts: GameOpts): Promise<void> {
  const term = new TerminalSession(process.stdin, process.stdout)
  const parser = new KeyParser()
  const quitConfirm = new QuitConfirm(() => performance.now())
  const colorMode = detectColorMode(process.env) === 'truecolor' ? 'truecolor' : 'basic'
  const bigPieces = supportsDoubleSizePieces(process.env)

  let cols = process.stdout.columns ?? 80
  let rows = process.stdout.rows ?? 24
  let sel: SelectState = INITIAL_SELECT_STATE
  let state: ChessState = initialState()
  let lastMove: Move | null = null
  const sanHistory: string[] = []
  let banner: string | null = null
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
    if (input.typed.length > 0) return `> ${input.typed}`
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
        bigPieces,
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

  const input = createInputTranslator(parser, {
    dispatch,
    redraw,
    squareAt: (x, y) => cellToSquare(x, y, cols, rows, opts.selfColor),
    hasPendingPromotion: () => sel.pendingPromotion !== null,
    hasBanner: () => banner !== null,
    clearBanner: () => { banner = null },
    quitArmed: () => quitConfirm.armed,
    requestQuit: () => { quit = quitConfirm.request(); redraw() },
    instantQuit: () => { quit = true },
  })
  process.stdin.on('data', input.onData)

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

  process.stdin.off('data', input.onData)
  process.stdout.off('resize', onResize)

  await teardownAndExit({
    term,
    parser,
    listener,
    finale: state.result
      ? {
          screen: renderBoard({
            state,
            selfColor: opts.selfColor,
            selected: null,
            legalTargets: [],
            lastMove,
            cursor: null,
            colorMode,
            bigPieces,
            cols,
            rows,
            sanHistory,
            opponentHandle: opts.opponentHandle,
            statusLine: `${resultLine(state.result, opts.selfColor)} — press any key`,
          }),
          shareText: shareCard(state.result, opts.selfColor, sanHistory.length, opts.opponentHandle),
        }
      : null,
  })
}
