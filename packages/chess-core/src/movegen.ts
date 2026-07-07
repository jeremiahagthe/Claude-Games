import type { ChessState, Color, Piece, PieceType } from './board.js'
import { INCREMENT_MS, sq, sqName } from './board.js'
import { detectResult } from './result.js'

export interface Move {
  from: number
  to: number
  promotion?: PieceType // q|r|b|n only
}

const PROMOTION_TYPES: PieceType[] = ['q', 'r', 'b', 'n']

const KNIGHT_OFFSETS: Array<[number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
]

const KING_OFFSETS: Array<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
]

const BISHOP_DIRS: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const ROOK_DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function inBounds(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8
}

function fileOf(i: number): number {
  return i % 8
}

function rankOf(i: number): number {
  return Math.floor(i / 8)
}

function opposite(c: Color): Color {
  return c === 'w' ? 'b' : 'w'
}

// Pseudo-legal moves: obey piece movement rules and board occupancy, but do
// not check whether the mover's own king ends up in check.
function pseudoLegalMoves(s: ChessState): Move[] {
  const moves: Move[] = []
  const { board, turn } = s

  for (let from = 0; from < 64; from++) {
    const piece = board[from]
    if (!piece || piece.color !== turn) continue
    const file = fileOf(from)
    const rank = rankOf(from)

    if (piece.type === 'n') {
      for (const [df, dr] of KNIGHT_OFFSETS) {
        const nf = file + df
        const nr = rank + dr
        if (!inBounds(nf, nr)) continue
        const to = sq(nf, nr)
        const target = board[to]
        if (!target || target.color !== turn) moves.push({ from, to })
      }
    } else if (piece.type === 'k') {
      for (const [df, dr] of KING_OFFSETS) {
        const nf = file + df
        const nr = rank + dr
        if (!inBounds(nf, nr)) continue
        const to = sq(nf, nr)
        const target = board[to]
        if (!target || target.color !== turn) moves.push({ from, to })
      }
      addCastlingMoves(s, from, moves)
    } else if (piece.type === 'b' || piece.type === 'r' || piece.type === 'q') {
      const dirs =
        piece.type === 'b' ? BISHOP_DIRS : piece.type === 'r' ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS]
      for (const [df, dr] of dirs) {
        let nf = file + df
        let nr = rank + dr
        while (inBounds(nf, nr)) {
          const to = sq(nf, nr)
          const target = board[to]
          if (!target) {
            moves.push({ from, to })
          } else {
            if (target.color !== turn) moves.push({ from, to })
            break
          }
          nf += df
          nr += dr
        }
      }
    } else if (piece.type === 'p') {
      addPawnMoves(s, from, file, rank, moves)
    }
  }

  return moves
}

function addPawnMoves(
  s: ChessState,
  from: number,
  file: number,
  rank: number,
  moves: Move[],
): void {
  const { board, turn, epSquare } = s
  const dir = turn === 'w' ? 1 : -1
  const startRank = turn === 'w' ? 1 : 6
  const promoRank = turn === 'w' ? 7 : 0

  const oneRank = rank + dir
  if (inBounds(file, oneRank)) {
    const oneTo = sq(file, oneRank)
    if (!board[oneTo]) {
      pushPawnMove(from, oneTo, oneRank === promoRank, moves)
      if (rank === startRank) {
        const twoRank = rank + 2 * dir
        const twoTo = sq(file, twoRank)
        if (!board[twoTo]) moves.push({ from, to: twoTo })
      }
    }
  }

  for (const df of [-1, 1]) {
    const nf = file + df
    if (!inBounds(nf, oneRank)) continue
    const to = sq(nf, oneRank)
    const target = board[to]
    if (target && target.color !== turn) {
      pushPawnMove(from, to, oneRank === promoRank, moves)
    } else if (epSquare !== null && to === epSquare) {
      moves.push({ from, to })
    }
  }
}

function pushPawnMove(from: number, to: number, isPromotion: boolean, moves: Move[]): void {
  if (isPromotion) {
    for (const promotion of PROMOTION_TYPES) moves.push({ from, to, promotion })
  } else {
    moves.push({ from, to })
  }
}

function addCastlingMoves(s: ChessState, kingFrom: number, moves: Move[]): void {
  const { board, turn, castling } = s
  const rank = turn === 'w' ? 0 : 7
  if (kingFrom !== sq(4, rank)) return
  if (isInCheck(s, turn)) return

  const kingSide = turn === 'w' ? castling.wk : castling.bk
  const queenSide = turn === 'w' ? castling.wq : castling.bq
  const enemy = opposite(turn)

  if (kingSide) {
    const f = sq(5, rank)
    const g = sq(6, rank)
    const rookSq = sq(7, rank)
    const rook = board[rookSq]
    if (rook && rook.type === 'r' && rook.color === turn && !board[f] && !board[g]) {
      if (!isSquareAttacked(board, f, enemy) && !isSquareAttacked(board, g, enemy)) {
        moves.push({ from: kingFrom, to: g })
      }
    }
  }

  if (queenSide) {
    const d = sq(3, rank)
    const c = sq(2, rank)
    const b = sq(1, rank)
    const rookSq = sq(0, rank)
    const rook = board[rookSq]
    if (rook && rook.type === 'r' && rook.color === turn && !board[d] && !board[c] && !board[b]) {
      if (!isSquareAttacked(board, d, enemy) && !isSquareAttacked(board, c, enemy)) {
        moves.push({ from: kingFrom, to: c })
      }
    }
  }
}

function isSquareAttacked(board: (Piece | null)[], target: number, byColor: Color): boolean {
  const tf = fileOf(target)
  const tr = rankOf(target)

  // Knight attacks.
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const nf = tf + df
    const nr = tr + dr
    if (!inBounds(nf, nr)) continue
    const p = board[sq(nf, nr)]
    if (p && p.color === byColor && p.type === 'n') return true
  }

  // King attacks.
  for (const [df, dr] of KING_OFFSETS) {
    const nf = tf + df
    const nr = tr + dr
    if (!inBounds(nf, nr)) continue
    const p = board[sq(nf, nr)]
    if (p && p.color === byColor && p.type === 'k') return true
  }

  // Sliding attacks (bishop/rook/queen).
  const slideChecks: Array<[Array<[number, number]>, PieceType[]]> = [
    [BISHOP_DIRS, ['b', 'q']],
    [ROOK_DIRS, ['r', 'q']],
  ]
  for (const [dirs, types] of slideChecks) {
    for (const [df, dr] of dirs) {
      let nf = tf + df
      let nr = tr + dr
      while (inBounds(nf, nr)) {
        const p = board[sq(nf, nr)]
        if (p) {
          if (p.color === byColor && types.includes(p.type)) return true
          break
        }
        nf += df
        nr += dr
      }
    }
  }

  // Pawn attacks: a pawn of byColor attacks target if it sits one diagonal
  // step "backward" from target relative to its own advance direction.
  const pawnDir = byColor === 'w' ? -1 : 1
  for (const df of [-1, 1]) {
    const nf = tf + df
    const nr = tr + pawnDir
    if (!inBounds(nf, nr)) continue
    const p = board[sq(nf, nr)]
    if (p && p.color === byColor && p.type === 'p') return true
  }

  return false
}

export function isInCheck(s: ChessState, color: Color): boolean {
  const kingSq = s.board.findIndex((p) => p !== null && p.type === 'k' && p.color === color)
  if (kingSq === -1) return false
  return isSquareAttacked(s.board, kingSq, opposite(color))
}

export function legalMoves(s: ChessState): Move[] {
  const pseudo = pseudoLegalMoves(s)
  const legal: Move[] = []
  for (const m of pseudo) {
    const next = applyMoveRaw(s, m)
    if (!isInCheck(next, s.turn)) legal.push(m)
  }
  return legal
}

export function positionKey(s: ChessState): string {
  const boardKey = s.board.map((p) => (p ? `${p.color}${p.type}` : '-')).join('')
  const castlingKey = `${s.castling.wk ? 'K' : ''}${s.castling.wq ? 'Q' : ''}${s.castling.bk ? 'k' : ''}${
    s.castling.bq ? 'q' : ''
  }`
  const epKey = s.epSquare === null ? '-' : sqName(s.epSquare)
  return `${boardKey}|${s.turn}|${castlingKey || '-'}|${epKey}`
}

// INTERNAL/ADVANCED: applies a move to the board/castling/ep/halfmove/
// history fields only — does not touch clocksMs or result. Used internally
// by legalMoves for check-filtering (which must not recurse into
// detectResult, since detectResult itself calls legalMoves). The public
// applyMove below wraps this with clock and result bookkeeping.
//
// Exported ONLY for use by performance-sensitive internals such as the bot's
// search (bot.ts), which needs to apply many moves per second without
// paying for a full detectResult (legalMoves) pass on every node. Ordinary
// callers — game loop, UI, protocol handlers — MUST use applyMove instead:
// this function does not stamp `result` and does not apply the move
// increment, so a caller that uses it for real gameplay will silently lose
// game-over detection and clock increments.
export function applyMoveRaw(s: ChessState, m: Move): ChessState {
  const piece = s.board[m.from]
  if (!piece || piece.color !== s.turn) throw new Error(`illegal move: no ${s.turn} piece on from-square`)

  const legal = pseudoLegalMoves(s).some(
    (lm) => lm.from === m.from && lm.to === m.to && lm.promotion === m.promotion,
  )
  if (!legal) throw new Error(`illegal move: ${JSON.stringify(m)}`)

  const board = s.board.slice()
  const turn = s.turn
  const enemy = opposite(turn)
  const fromFile = fileOf(m.from)
  const fromRank = rankOf(m.from)
  const toFile = fileOf(m.to)
  const toRank = rankOf(m.to)

  const isPawnMove = piece.type === 'p'
  const isCapture = board[m.to] !== null
  let isEnPassantCapture = false

  const castling = { ...s.castling }

  if (isPawnMove && m.to === s.epSquare && toFile !== fromFile) {
    // En passant capture: remove the captured pawn, which sits on the
    // same rank as the mover and the same file as the destination.
    isEnPassantCapture = true
    const capturedSq = sq(toFile, fromRank)
    board[capturedSq] = null
  }

  if (piece.type === 'k' && Math.abs(toFile - fromFile) === 2) {
    const rank = fromRank
    if (toFile === 6) {
      // king side: rook a-h -> f
      const rookFrom = sq(7, rank)
      const rookTo = sq(5, rank)
      board[rookTo] = board[rookFrom] ?? null
      board[rookFrom] = null
    } else if (toFile === 2) {
      // queen side: rook -> d
      const rookFrom = sq(0, rank)
      const rookTo = sq(3, rank)
      board[rookTo] = board[rookFrom] ?? null
      board[rookFrom] = null
    }
  }

  board[m.from] = null
  board[m.to] = m.promotion ? { type: m.promotion, color: turn } : piece

  // Update castling rights: king move, rook move, or rook captured on its home square.
  if (piece.type === 'k') {
    if (turn === 'w') {
      castling.wk = false
      castling.wq = false
    } else {
      castling.bk = false
      castling.bq = false
    }
  }
  if (piece.type === 'r') {
    if (m.from === sq(0, 0)) castling.wq = false
    else if (m.from === sq(7, 0)) castling.wk = false
    else if (m.from === sq(0, 7)) castling.bq = false
    else if (m.from === sq(7, 7)) castling.bk = false
  }
  if (m.to === sq(0, 0)) castling.wq = false
  else if (m.to === sq(7, 0)) castling.wk = false
  else if (m.to === sq(0, 7)) castling.bq = false
  else if (m.to === sq(7, 7)) castling.bk = false

  // epSquare: set only on a double pawn push, else cleared.
  let epSquare: number | null = null
  if (isPawnMove && Math.abs(toRank - fromRank) === 2) {
    epSquare = sq(fromFile, (fromRank + toRank) / 2)
  }

  const halfmoveClock = isPawnMove || isCapture || isEnPassantCapture ? 0 : s.halfmoveClock + 1
  const fullmove = turn === 'b' ? s.fullmove + 1 : s.fullmove
  const nextTurn: Color = enemy

  const next: ChessState = {
    board,
    turn: nextTurn,
    castling,
    epSquare,
    halfmoveClock,
    fullmove,
    clocksMs: s.clocksMs,
    history: s.history,
    result: s.result,
  }

  // Seed the position the game started from into history on the very first
  // move: a fresh ChessState (from initialState/fromFEN) starts with an
  // empty history array, so without this the starting position would never
  // be recorded and could never be counted toward threefold repetition.
  // Note: `history.length === 0` is a proxy for "fresh state constructed by
  // initialState/fromFEN" — any state that has already been through
  // applyMove carries a non-empty history.
  next.history = s.history.length === 0 ? [positionKey(s), positionKey(next)] : [...s.history, positionKey(next)]

  return next
}

/**
 * Applies a legal move to the board. Contract (3+2 clocks): the caller must
 * tick the mover's clock down via tickClock BEFORE calling applyMove;
 * applyMove then ADDS INCREMENT_MS to the mover's clock after the move.
 * Also stamps `result` via detectResult, reflecting checkmate/stalemate/
 * fifty-move/threefold/insufficient-material as of the resulting position.
 */
export function applyMove(s: ChessState, m: Move): ChessState {
  const mover = s.turn
  const raw = applyMoveRaw(s, m)
  const clocksMs = { ...raw.clocksMs, [mover]: raw.clocksMs[mover] + INCREMENT_MS }
  const next: ChessState = { ...raw, clocksMs }
  next.result = detectResult(next)
  return next
}
