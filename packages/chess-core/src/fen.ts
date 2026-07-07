import type { ChessState, Color, Piece, PieceType } from './board.js'
import { INITIAL_CLOCK_MS, nameSq, sq, sqName } from './board.js'

const PIECE_LETTERS: Record<PieceType, string> = {
  p: 'p',
  n: 'n',
  b: 'b',
  r: 'r',
  q: 'q',
  k: 'k',
}

function pieceToLetter(p: Piece): string {
  const letter = PIECE_LETTERS[p.type]
  return p.color === 'w' ? letter.toUpperCase() : letter
}

function letterToPiece(letter: string): Piece {
  const lower = letter.toLowerCase()
  const type = (Object.keys(PIECE_LETTERS) as PieceType[]).find((t) => t === lower)
  if (!type) throw new Error(`invalid FEN piece letter: ${letter}`)
  const color: Color = letter === lower ? 'b' : 'w'
  return { type, color }
}

export function toFEN(s: ChessState): string {
  const rows: string[] = []
  for (let rank = 7; rank >= 0; rank--) {
    let row = ''
    let empty = 0
    for (let file = 0; file < 8; file++) {
      const piece = s.board[sq(file, rank)]
      if (!piece) {
        empty++
        continue
      }
      if (empty > 0) {
        row += String(empty)
        empty = 0
      }
      row += pieceToLetter(piece)
    }
    if (empty > 0) row += String(empty)
    rows.push(row)
  }
  const boardField = rows.join('/')

  let castling = ''
  if (s.castling.wk) castling += 'K'
  if (s.castling.wq) castling += 'Q'
  if (s.castling.bk) castling += 'k'
  if (s.castling.bq) castling += 'q'
  if (castling === '') castling = '-'

  const ep = s.epSquare === null ? '-' : sqName(s.epSquare)

  return `${boardField} ${s.turn} ${castling} ${ep} ${s.halfmoveClock} ${s.fullmove}`
}

export function fromFEN(fen: string): ChessState {
  const fields = fen.trim().split(/\s+/)
  if (fields.length !== 6) throw new Error(`invalid FEN: expected 6 fields, got ${fields.length}`)
  const [boardField, turnField, castlingField, epField, halfmoveField, fullmoveField] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]

  const ranks = boardField.split('/')
  if (ranks.length !== 8) throw new Error(`invalid FEN board: expected 8 ranks, got ${ranks.length}`)

  const board: (Piece | null)[] = new Array(64).fill(null)
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r
    const row = ranks[r]!
    let file = 0
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch)
        continue
      }
      if (file > 7) throw new Error(`invalid FEN rank (overflow): ${row}`)
      board[sq(file, rank)] = letterToPiece(ch)
      file++
    }
    if (file !== 8) throw new Error(`invalid FEN rank (wrong length): ${row}`)
  }

  if (turnField !== 'w' && turnField !== 'b') throw new Error(`invalid FEN turn field: ${turnField}`)
  const turn: Color = turnField

  const castling = { wk: false, wq: false, bk: false, bq: false }
  if (castlingField !== '-') {
    for (const ch of castlingField) {
      if (ch === 'K') castling.wk = true
      else if (ch === 'Q') castling.wq = true
      else if (ch === 'k') castling.bk = true
      else if (ch === 'q') castling.bq = true
      else throw new Error(`invalid FEN castling field: ${castlingField}`)
    }
  }

  const epSquare = epField === '-' ? null : nameSq(epField)

  const halfmoveClock = Number(halfmoveField)
  const fullmove = Number(fullmoveField)
  if (!Number.isInteger(halfmoveClock) || halfmoveClock < 0) {
    throw new Error(`invalid FEN halfmove clock: ${halfmoveField}`)
  }
  if (!Number.isInteger(fullmove) || fullmove < 1) {
    throw new Error(`invalid FEN fullmove number: ${fullmoveField}`)
  }

  return {
    board,
    turn,
    castling,
    epSquare,
    halfmoveClock,
    fullmove,
    clocksMs: { w: INITIAL_CLOCK_MS, b: INITIAL_CLOCK_MS },
    history: [],
    result: null,
  }
}
