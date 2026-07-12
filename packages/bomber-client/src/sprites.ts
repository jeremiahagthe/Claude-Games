// 8x8 sprites (chess-4 board-render.ts's half-block ▀▄ compositing pipeline,
// generalized): each mask is 8 numbers, one per row, each row an 8-bit value
// (bit 7 = leftmost pixel, bit 0 = rightmost). A tile is `2r` terminal
// columns x `r` terminal rows; two vertical pixels pack into each terminal
// row via ▀▄, so the pixel grid a mask scales into is always `2r x 2r` —
// square — hence scaleMask below takes a single `px` side length.

// prettier-ignore
const PERSON = [
  0b00111100, // ..####..
  0b01111110, // .######.
  0b00111100, // ..####..
  0b01111110, // .######.
  0b11111111, // ########
  0b01111110, // .######.
  0b00100100, // ..#..#..
  0b01000010, // .#....#.
]

// prettier-ignore
const BOMB0 = [ // long fuse, spark far from the body
  0b00011000,
  0b00100000,
  0b01111110,
  0b11111111,
  0b11111111,
  0b11111111,
  0b01111110,
  0b00111100,
]

// prettier-ignore
const BOMB1 = [ // fuse burned down, spark close to the body
  0b00100000,
  0b01000000,
  0b01111110,
  0b11111111,
  0b11111111,
  0b11111111,
  0b01111110,
  0b00111100,
]

// prettier-ignore
const BOMB2 = [ // about to blow — sparks ring the whole body
  0b10101010,
  0b01111110,
  0b11111111,
  0b11111111,
  0b11111111,
  0b11111111,
  0b01111110,
  0b10111101,
]

// prettier-ignore
const FLAME = [
  0b00100100,
  0b01011010,
  0b10111101,
  0b01111110,
  0b11111111,
  0b01111110,
  0b10111101,
  0b01000010,
]

// prettier-ignore
const SOFT = [ // crate texture — distinct from HARD's solid fill
  0b11111111,
  0b10100101,
  0b10100101,
  0b11111111,
  0b10100101,
  0b10100101,
  0b11111111,
  0b11111111,
]

const HARD = [0b11111111, 0b11111111, 0b11111111, 0b11111111, 0b11111111, 0b11111111, 0b11111111, 0b11111111]

// prettier-ignore
const DROP_BOMB = [ // small centered disc — reads as a token, not a person
  0b00000000,
  0b00111100,
  0b01111110,
  0b01111110,
  0b01111110,
  0b00111100,
  0b00000000,
  0b00000000,
]

// prettier-ignore
const DROP_RANGE = [ // cross/blast-radius glyph
  0b00011000,
  0b00011000,
  0b00011000,
  0b11111111,
  0b11111111,
  0b00011000,
  0b00011000,
  0b00011000,
]

// prettier-ignore
const DROP_SPEED = [ // chevron pointing right
  0b10000000,
  0b11000000,
  0b11100000,
  0b11110000,
  0b11110000,
  0b11100000,
  0b11000000,
  0b10000000,
]

export const SPRITES: Record<string, number[]> = {
  p0: PERSON,
  p1: PERSON,
  p2: PERSON,
  p3: PERSON,
  bomb0: BOMB0,
  bomb1: BOMB1,
  bomb2: BOMB2,
  flame: FLAME,
  soft: SOFT,
  hard: HARD,
  'drop-bomb': DROP_BOMB,
  'drop-range': DROP_RANGE,
  'drop-speed': DROP_SPEED,
}

// Nearest-neighbor scale of an 8x8 bitmask to a px*px boolean grid.
export function scaleMask(mask: number[], px: number): boolean[][] {
  const out: boolean[][] = []
  for (let y = 0; y < px; y++) {
    const sy = Math.min(7, Math.floor((y * 8) / px))
    const bits = mask[sy] ?? 0
    const row: boolean[] = []
    for (let x = 0; x < px; x++) {
      const sx = Math.min(7, Math.floor((x * 8) / px))
      row.push(((bits >> (7 - sx)) & 1) === 1)
    }
    out.push(row)
  }
  return out
}
