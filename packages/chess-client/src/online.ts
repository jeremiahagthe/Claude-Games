// Online flow: POST /chess/join → matched (ws handshake) or noOpponent/any
// failure → single fallback path through game.ts's synchronous bot loop.
// Once matched, this module runs its OWN loop (not runGame) — moves are
// server-relay events (both the player's own move and the opponent's arrive
// the same way, via the 'move' message) rather than a synchronous local
// apply, so the input/redraw wiring genuinely differs from offline's.
import type { ChessDifficulty, ChessState, Color, Move } from 'checkwait-core'
import { applyMove, fromFEN, legalMoves, parseMove, sanitizeHandle, sqName, toSAN } from 'checkwait-core'
import { hostname } from 'node:os'
import { cellToSquare, renderBoard } from './board-render.js'
import { detectColorMode } from './caps.js'
import { startClaudeListener } from './claude.js'
import { resultLine, type GameOpts } from './game.js'
import { runGame } from './game.js'
import { waitForPress } from './input/dismiss.js'
import { KeyParser } from './input/parser.js'
import { QuitConfirm } from './input/quit.js'
import { ChessNetClient, joinChessLobby } from './net.js'
import { INITIAL_SELECT_STATE, selectStep, type SelectEvent, type SelectState } from './select.js'
import { shareCard } from './share.js'
import { TerminalSession } from './terminal.js'

export interface OnlineOpts {
  name?: string
  server: string
  difficulty: ChessDifficulty
}

const MOVE_CHARS = /^[a-hA-H1-8KQRBNOx=+#-]$/
const TYPED_BUFFER_MAX = 10
const REDRAW_MS = 100 // 10fps

function moveToCoord(m: Move): string {
  return `${sqName(m.from)}${sqName(m.to)}${m.promotion ?? ''}`
}

function botFallbackOpts(opts: OnlineOpts): GameOpts {
  return { selfColor: 'w', difficulty: opts.difficulty, opponentHandle: `bot·${opts.difficulty}` }
}

export async function runOnline(opts: OnlineOpts): Promise<void> {
  const handle = sanitizeHandle(opts.name ?? hostname())

  const joined = await joinChessLobby(opts.server)
  if (joined.kind !== 'matched') {
    console.log('checkwait: no opponent online — playing the bot\n')
    await runGame(botFallbackOpts(opts))
    return
  }

  // Mutated by the onMove/onEnd handlers below, which start receiving events
  // the instant the ws opens — populated synchronously right after connect()
  // resolves and before any further message can be processed (single-
  // threaded JS: the handshake promise's own resolution runs to completion
  // before the event loop dispatches another 'message' event).
  let state!: ChessState
  // Boxed (rather than a bare `let`) so reading `.value` after it's set from
  // inside the onEnd closure below narrows correctly — a bare `let` mutated
  // only from a nested closure collapses to `never` at the read site under
  // this TS version's control-flow analysis.
  const ended: { value: { result: NonNullable<ChessState['result']>; state: ChessState } | null } = { value: null }
  let closed = false
  let lastMove: Move | null = null
  const sanHistory: string[] = []
  let awaitingAck = false // true while our own move is in flight, unacked
  // Server clocksMs are authoritative; between messages the HUD ticks the
  // to-move side down locally from the last authoritative snapshot, purely
  // for display (never used to decide a flag — only the server can end the
  // game on time).
  let clocksBaseline = { w: 0, b: 0 }
  let clocksBaselineAt = performance.now()

  let connected: Awaited<ReturnType<typeof ChessNetClient.connect>>
  try {
    connected = await ChessNetClient.connect(opts.server, joined.matchId, handle, {
      // The server broadcasts every move (ours AND the opponent's) back
      // through this same relay — there is no separate "your move was
      // accepted" message, so this is also what clears awaitingAck.
      onMove(move, clocksMs, _seq) {
        const found = parseMove(state, move)
        // Server is authoritative and only ever relays legal moves against
        // the state it already agreed with us on — this should never miss,
        // but a malformed/rogue message must not crash the client.
        if (!found) return
        sanHistory.push(toSAN(state, found)) // toSAN needs the position BEFORE applyMove
        state = { ...applyMove(state, found), clocksMs }
        lastMove = found
        awaitingAck = false
        clocksBaseline = clocksMs
        clocksBaselineAt = performance.now()
      },
      onEnd(result, fen) {
        ended.value = { result, state: { ...fromFEN(fen), clocksMs: state?.clocksMs ?? { w: 0, b: 0 }, result } }
      },
      onClose() {
        closed = true
      },
    })
  } catch {
    console.log('checkwait: no opponent online — playing the bot\n')
    await runGame(botFallbackOpts(opts))
    return
  }

  const { client: net, welcome } = connected
  const selfColor: Color = welcome.color
  const opponentHandle = welcome.opponent
  state = { ...fromFEN(welcome.state), clocksMs: welcome.clocksMs }
  clocksBaseline = welcome.clocksMs
  clocksBaselineAt = performance.now()
  let seq = 0

  const term = new TerminalSession(process.stdin, process.stdout)
  const parser = new KeyParser()
  const quitConfirm = new QuitConfirm(() => performance.now())
  const colorMode = detectColorMode(process.env) === 'truecolor' ? 'truecolor' : 'basic'

  let cols = process.stdout.columns ?? 80
  let rows = process.stdout.rows ?? 24
  let sel: SelectState = INITIAL_SELECT_STATE
  let banner: string | null = null
  let typedBuffer = ''
  let quit = false

  function currentStatusLine(): string {
    if (quitConfirm.armed) return 'press again to resign'
    if (sel.pendingPromotion) return 'promote: (q)ueen (r)ook (b)ishop k(n)ight'
    if (banner) return banner
    if (awaitingAck) return 'sending…'
    if (typedBuffer.length > 0) return `> ${typedBuffer}`
    return ''
  }

  function displayClocksMs(): { w: number; b: number } {
    const elapsed = performance.now() - clocksBaselineAt
    return { ...clocksBaseline, [state.turn]: Math.max(0, clocksBaseline[state.turn] - elapsed) }
  }

  function redraw(): void {
    const legalTargets =
      sel.selected === null ? [] : legalMoves(state).filter((m) => m.from === sel.selected).map((m) => m.to)
    term.write(
      renderBoard({
        state: { ...state, clocksMs: displayClocksMs() },
        selfColor,
        selected: sel.selected,
        legalTargets,
        lastMove,
        cursor: sel.cursor,
        colorMode,
        cols,
        rows,
        sanHistory,
        opponentHandle,
        statusLine: currentStatusLine(),
      }),
    )
  }

  // Sends the player's own move to the server and blocks further input until
  // it comes back through onMove (the 'move' relay is the ONLY thing that
  // ever advances `state` — this keeps a single source of truth instead of
  // reconciling an optimistic local apply against the server's answer).
  function sendOwnMove(move: Move): void {
    awaitingAck = true
    net.sendMove(moveToCoord(move), seq++)
  }

  function dispatch(e: SelectEvent): void {
    if (awaitingAck) return
    const { sel: nextSel, move } = selectStep(state, sel, e, selfColor)
    sel = nextSel
    if (move) sendOwnMove(move)
    redraw()
  }

  const listener = await startClaudeListener()
  listener.onEvent((event) => {
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
          const square = cellToSquare(e.x, e.y, cols, rows, selfColor)
          if (square !== null) dispatch({ kind: 'click', square })
        }
        continue
      }
      if (e.kind !== 'press') continue
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
      if (lower === 'q' && typedBuffer.length === 0) {
        quit = quitConfirm.request()
        redraw()
        continue
      }
      if (awaitingAck) continue // move in flight: no board input until it's acked

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
  term.installExitGuards(() => net.close())
  redraw()

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (quit || ended.value || closed || state.result) {
        clearInterval(timer)
        resolve()
        return
      }
      redraw()
    }, REDRAW_MS)
  })

  process.stdin.off('data', onData)
  process.stdout.off('resize', onResize)

  if (quit) net.resign()

  const finalState: ChessState | null = ended.value ? ended.value.state : state.result ? state : null
  const finished = finalState !== null
  if (finished) {
    state = finalState
    term.write(
      renderBoard({
        state,
        selfColor,
        selected: null,
        legalTargets: [],
        lastMove,
        cursor: null,
        colorMode,
        cols,
        rows,
        sanHistory,
        opponentHandle,
        statusLine: `${resultLine(state.result!, selfColor)} — press any key`,
      }),
    )
    await waitForPress(process.stdin, parser)
  }

  await listener.close()
  net.close()
  term.restore()
  if (finished) {
    process.stdout.write('\n' + shareCard(state.result!, selfColor, sanHistory.length, opponentHandle))
  }
  process.exit(0)
}
