export type Color = 'w' | 'b'
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'

export interface Piece {
  type: PieceType
  color: Color
}

export interface ChessState {
  board: (Piece | null)[] // 64 entries, index = rank*8+file, a1=0 … h8=63
  turn: Color
  castling: { wk: boolean; wq: boolean; bk: boolean; bq: boolean }
  epSquare: number | null
  halfmoveClock: number
  fullmove: number
  clocksMs: { w: number; b: number }
  history: string[] // positionKey strings for threefold
  result: Result | null
}

export type Result =
  | { kind: 'checkmate' | 'resign' | 'flag'; winner: Color }
  | { kind: 'stalemate' | 'fifty-move' | 'threefold' | 'insufficient' }

export const INITIAL_CLOCK_MS = 3 * 60_000
export const INCREMENT_MS = 2_000

const FILES = 'abcdefgh'

export function sq(file: number, rank: number): number {
  return rank * 8 + file
}

export function sqName(i: number): string {
  const file = i % 8
  const rank = Math.floor(i / 8)
  return `${FILES[file]}${rank + 1}`
}

export function nameSq(n: string): number {
  if (!/^[a-h][1-8]$/.test(n)) throw new Error(`invalid square name: ${n}`)
  const file = FILES.indexOf(n[0]!)
  const rank = Number(n[1]) - 1
  return sq(file, rank)
}

const BACK_RANK: PieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r']

export function initialState(): ChessState {
  const board: (Piece | null)[] = new Array(64).fill(null)
  for (let file = 0; file < 8; file++) {
    const type = BACK_RANK[file]!
    board[sq(file, 0)] = { type, color: 'w' }
    board[sq(file, 1)] = { type: 'p', color: 'w' }
    board[sq(file, 6)] = { type: 'p', color: 'b' }
    board[sq(file, 7)] = { type, color: 'b' }
  }
  return {
    board,
    turn: 'w',
    castling: { wk: true, wq: true, bk: true, bq: true },
    epSquare: null,
    halfmoveClock: 0,
    fullmove: 1,
    clocksMs: { w: INITIAL_CLOCK_MS, b: INITIAL_CLOCK_MS },
    history: [],
    result: null,
  }
}
