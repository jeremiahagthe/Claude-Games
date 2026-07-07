import type { ChessState, PieceType } from './board.js'
import { nameSq, sqName } from './board.js'
import type { Move } from './movegen.js'
import { applyMove, isInCheck, legalMoves } from './movegen.js'

const FILES = 'abcdefgh'

function fileOf(i: number): number {
  return i % 8
}

function rankOf(i: number): number {
  return Math.floor(i / 8)
}

const PIECE_LETTER_TO_TYPE: Record<string, PieceType> = {
  N: 'n',
  B: 'b',
  R: 'r',
  Q: 'q',
  K: 'k',
}

const TYPE_TO_UPPER_LETTER: Record<PieceType, string> = {
  p: '',
  n: 'N',
  b: 'B',
  r: 'R',
  q: 'Q',
  k: 'K',
}

const COORD_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i

// Piece letter (optional), disambiguation file/rank (both optional), capture
// flag (optional), target square, promotion suffix (optional), check/mate
// suffix (optional, ignored for parsing purposes).
const SAN_RE = /^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([QRBN]))?[+#]?$/

function isCastlingMove(s: ChessState, m: Move): boolean {
  const piece = s.board[m.from]
  return !!piece && piece.type === 'k' && Math.abs(fileOf(m.to) - fileOf(m.from)) === 2
}

function findCastlingMove(s: ChessState, targetFile: 2 | 6): Move | null {
  for (const m of legalMoves(s)) {
    const piece = s.board[m.from]
    if (piece && piece.type === 'k' && Math.abs(fileOf(m.to) - fileOf(m.from)) === 2 && fileOf(m.to) === targetFile) {
      return m
    }
  }
  return null
}

/**
 * Parses coordinate ('e2e4', 'e7e8q') or SAN ('Nf3', 'exd5', 'O-O', 'O-O-O',
 * 'e8=Q', 'Qxf7+', 'Raxd1') input against the LEGAL moves of `s`. Returns
 * null for anything that does not name exactly one legal move — never
 * throws on user input.
 */
export function parseMove(s: ChessState, input: string): Move | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  const coordMatch = COORD_RE.exec(trimmed)
  if (coordMatch) {
    const [, fromName, toName, promoLetter] = coordMatch as unknown as [string, string, string, string | undefined]
    const from = nameSq(fromName.toLowerCase())
    const to = nameSq(toName.toLowerCase())
    const wantPromotion = promoLetter ? (promoLetter.toLowerCase() as PieceType) : undefined
    const found = legalMoves(s).find(
      (m) => m.from === from && m.to === to && (m.promotion ?? undefined) === wantPromotion,
    )
    return found ?? null
  }

  const castlingBase = trimmed.replace(/[+#]$/, '')
  if (castlingBase === 'O-O-O') return findCastlingMove(s, 2)
  if (castlingBase === 'O-O') return findCastlingMove(s, 6)

  const sanMatch = SAN_RE.exec(trimmed)
  if (!sanMatch) return null

  const [, pieceLetter, disambigFileCh, disambigRankCh, , targetName, promoLetter] = sanMatch
  const type: PieceType = pieceLetter ? PIECE_LETTER_TO_TYPE[pieceLetter]! : 'p'
  const target = nameSq(targetName!)
  const disambigFile = disambigFileCh ? FILES.indexOf(disambigFileCh) : undefined
  const disambigRank = disambigRankCh ? Number(disambigRankCh) - 1 : undefined
  const wantPromotion = promoLetter ? (promoLetter.toLowerCase() as PieceType) : undefined

  const candidates = legalMoves(s).filter((m) => {
    const piece = s.board[m.from]
    if (!piece || piece.type !== type) return false
    if (m.to !== target) return false
    if (disambigFile !== undefined && fileOf(m.from) !== disambigFile) return false
    if (disambigRank !== undefined && rankOf(m.from) !== disambigRank) return false
    if ((m.promotion ?? undefined) !== wantPromotion) return false
    return true
  })

  return candidates.length === 1 ? candidates[0]! : null
}

function disambiguation(s: ChessState, m: Move, type: PieceType): string {
  const others = legalMoves(s).filter((c) => {
    if (c.from === m.from) return false
    if (c.to !== m.to) return false
    const piece = s.board[c.from]
    return !!piece && piece.type === type
  })
  if (others.length === 0) return ''

  const sameFile = others.some((o) => fileOf(o.from) === fileOf(m.from))
  const sameRank = others.some((o) => rankOf(o.from) === rankOf(m.from))
  if (!sameFile) return FILES[fileOf(m.from)]!
  if (!sameRank) return String(rankOf(m.from) + 1)
  return `${FILES[fileOf(m.from)]}${rankOf(m.from) + 1}`
}

/**
 * Standard SAN for a legal move `m` in position `s`: minimal disambiguation,
 * 'x' for captures, '=Q' promotions, '+'/'#' for check/mate against the
 * resulting position, 'O-O'/'O-O-O' for castling.
 */
export function toSAN(s: ChessState, m: Move): string {
  const piece = s.board[m.from]
  if (!piece) throw new Error(`toSAN: no piece on from-square ${sqName(m.from)}`)

  const next = applyMove(s, m)
  const opponentInCheck = isInCheck(next, next.turn)
  const opponentHasMoves = legalMoves(next).length > 0
  const suffix = opponentInCheck ? (opponentHasMoves ? '+' : '#') : ''

  if (isCastlingMove(s, m)) {
    const base = fileOf(m.to) === 6 ? 'O-O' : 'O-O-O'
    return base + suffix
  }

  const isCapture =
    s.board[m.to] !== null || (piece.type === 'p' && m.to === s.epSquare && fileOf(m.to) !== fileOf(m.from))
  const targetName = sqName(m.to)
  const promoSuffix = m.promotion ? `=${TYPE_TO_UPPER_LETTER[m.promotion]}` : ''

  if (piece.type === 'p') {
    const filePrefix = isCapture ? `${FILES[fileOf(m.from)]}x` : ''
    return `${filePrefix}${targetName}${promoSuffix}${suffix}`
  }

  const pieceLetter = TYPE_TO_UPPER_LETTER[piece.type]
  const disambig = disambiguation(s, m, piece.type)
  const captureMark = isCapture ? 'x' : ''
  return `${pieceLetter}${disambig}${captureMark}${targetName}${promoSuffix}${suffix}`
}
