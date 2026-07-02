import type { ColorMode } from './caps.js'

export class FrameBuffer {
  px: Uint8Array
  constructor(readonly w: number, readonly h: number) {
    this.px = new Uint8Array(w * h * 3)
  }
  set(x: number, y: number, r: number, g: number, b: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 3
    this.px[i] = r
    this.px[i + 1] = g
    this.px[i + 2] = b
  }
  fill(r: number, g: number, b: number): void {
    for (let i = 0; i < this.px.length; i += 3) {
      this.px[i] = r
      this.px[i + 1] = g
      this.px[i + 2] = b
    }
  }
}

export function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return 232 + Math.round(((r - 8) / 247) * 23)
  }
  const q = (v: number) => Math.round((v / 255) * 5)
  return 16 + 36 * q(r) + 6 * q(g) + q(b)
}

const MONO_RAMP = ' .:-=+*#%@'
const ESC = '\x1b'

export class TermRenderer {
  private prev: Uint8Array | null = null
  constructor(private mode: ColorMode) {}

  reset(): void {
    this.prev = null
  }

  frame(fb: FrameBuffer): string {
    const rows = fb.h >> 1
    const out: string[] = []
    let lastRow = -1
    let lastCol = -1
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < fb.w; col++) {
        const ti = (row * 2 * fb.w + col) * 3
        const bi = ((row * 2 + 1) * fb.w + col) * 3
        if (this.prev) {
          let same = true
          for (let k = 0; k < 3; k++) {
            if (this.prev[ti + k] !== fb.px[ti + k] || this.prev[bi + k] !== fb.px[bi + k]) {
              same = false
              break
            }
          }
          if (same) continue
        }
        if (row !== lastRow || col !== lastCol + 1) out.push(`${ESC}[${row + 1};${col + 1}H`)
        out.push(this.cell(fb.px[ti]!, fb.px[ti + 1]!, fb.px[ti + 2]!, fb.px[bi]!, fb.px[bi + 1]!, fb.px[bi + 2]!))
        lastRow = row
        lastCol = col
      }
    }
    this.prev = Uint8Array.from(fb.px)
    return out.join('')
  }

  private cell(tr: number, tg: number, tb: number, br: number, bg: number, bb: number): string {
    if (this.mode === 'truecolor') return `${ESC}[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m▀`
    if (this.mode === '256') return `${ESC}[38;5;${rgbTo256(tr, tg, tb)};48;5;${rgbTo256(br, bg, bb)}m▀`
    const lum = (0.2126 * tr + 0.7152 * tg + 0.0722 * tb) / 255
    return MONO_RAMP[Math.min(MONO_RAMP.length - 1, Math.floor(lum * MONO_RAMP.length))]!
  }
}
