import type { ActivePiece } from './state.js'

export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'L' | 'J'
export type Rot = 0 | 1 | 2 | 3

export const KINDS: readonly PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'L', 'J'] // wire/board code = index+1

export const BOX: Record<PieceKind, number> = {
  I: 4, O: 2, T: 3, S: 3, Z: 3, L: 3, J: 3,
}

// rotation-0 cells in box, y-DOWN (row 0 = box top)
export const SHAPES: Record<PieceKind, [number, number][]> = {
  I: [[0, 1], [1, 1], [2, 1], [3, 1]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
}

// one CW turn in box size N maps (x,y) -> (N-1-y, x); O's rotation is identity.
function rotateCells(kind: PieceKind, rot: Rot): [number, number][] {
  const n = BOX[kind]
  let cells: [number, number][] = SHAPES[kind]
  if (kind === 'O') return cells
  for (let i = 0; i < rot; i++) {
    cells = cells.map(([x, y]) => [n - 1 - y, x] as [number, number])
  }
  return cells
}

export function cellsAt(kind: PieceKind, rot: Rot, x: number, y: number): [number, number][] {
  return rotateCells(kind, rot).map(([cx, cy]) => [x + cx, y + cy])
}

// SRS kick tables (JLSTZ + I), ALREADY converted to y-down convention.
// keys '01','10','12','21','23','32','30','03' = rotation from -> to.
export const KICKS_JLSTZ = {
  '01': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], '10': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '12': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '21': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '23': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], '32': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '30': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '03': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
} as const satisfies Record<string, [number, number][]>

export const KICKS_I = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]], '10': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]], '21': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]], '32': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]], '03': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
} as const satisfies Record<string, [number, number][]>

export function spawnPiece(kind: PieceKind): ActivePiece {
  return { kind, rot: 0, x: kind === 'O' ? 4 : 3, y: 2 }
}
