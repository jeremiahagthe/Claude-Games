// copied from packages/block-client/test/vtsim.ts — keep byte-identical
// A minimal VT terminal simulator — just enough to model the positional-escape
// surface the renderer relies on, so a headless capture can be asserted for
// in-bounds, repaint-in-place frames. Positional escapes were a FEEL-GATE-ONLY
// surface for two shipped defects (scroll-instead-of-repaint, and the col-80
// pending-wrap erase), so this class exists to turn that surface into a test.
//
// Modelled behaviours:
//   ESC[H          home the cursor AND snapshot the current grid as a frame
//                  boundary (the renderer emits exactly ESC[H once per frame)
//   ESC[r;cH       cursor position (1-indexed → 0-indexed)
//   ESC[K          clear from the cursor to end-of-line
//   ESC[J          clear from the cursor to end-of-screen
//   ESC[2J         clear the whole screen
//   ESC[...m       SGR — skipped (colour has no effect on the cell grid)
//   \r             carriage return (col → 0, clears pending-wrap)
//   \n             line feed (row + 1, clears pending-wrap)
//   printable char advance the cursor with PENDING-WRAP semantics at the last
//                  column: writing column `cols-1` places the glyph and sets
//                  pending-wrap instead of advancing, so the next glyph wraps
//                  to the next row first. This is the col-80 defect surface.
export class VtSim {
  private grid: string[][]
  private row = 0
  private col = 0
  private pendingWrap = false
  private snapshots: string[][] = []

  constructor(private cols: number, private rows: number) {
    this.grid = this.blankGrid()
  }

  private blankGrid(): string[][] {
    return Array.from({ length: this.rows }, () => new Array<string>(this.cols).fill(' '))
  }

  private snapshot(): void {
    this.snapshots.push(this.grid.map((r) => r.join('')))
  }

  feed(chunk: string): void {
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]!
      if (ch === '\x1b' && chunk[i + 1] === '[') {
        // Consume a CSI sequence: ESC [ (params) (final letter).
        let j = i + 2
        while (j < chunk.length && !/[A-Za-z]/.test(chunk[j]!)) j++
        const params = chunk.slice(i + 2, j)
        const final = chunk[j] ?? ''
        this.applyCsi(params, final)
        i = j + 1
        continue
      }
      if (ch === '\r') {
        this.col = 0
        this.pendingWrap = false
      } else if (ch === '\n') {
        this.row = Math.min(this.rows - 1, this.row + 1)
        this.pendingWrap = false
      } else if (ch >= ' ') {
        this.putChar(ch)
      }
      i++
    }
  }

  private applyCsi(params: string, final: string): void {
    switch (final) {
      case 'H': {
        if (params === '') {
          // Home + frame boundary: snapshot the frame the renderer just drew.
          this.snapshot()
          this.row = 0
          this.col = 0
          this.pendingWrap = false
        } else {
          const [r, c] = params.split(';').map((n) => Number(n) || 1)
          this.row = Math.min(this.rows - 1, Math.max(0, (r ?? 1) - 1))
          this.col = Math.min(this.cols - 1, Math.max(0, (c ?? 1) - 1))
          this.pendingWrap = false
        }
        break
      }
      case 'K': // clear cursor → end of line
        for (let x = this.col; x < this.cols; x++) this.grid[this.row]![x] = ' '
        break
      case 'J': {
        if (params === '2') {
          this.grid = this.blankGrid()
        } else {
          for (let x = this.col; x < this.cols; x++) this.grid[this.row]![x] = ' '
          for (let y = this.row + 1; y < this.rows; y++) this.grid[y] = new Array<string>(this.cols).fill(' ')
        }
        break
      }
      // SGR ('m') and anything else: no cell-grid effect.
    }
  }

  private putChar(ch: string): void {
    if (this.pendingWrap) {
      this.row = Math.min(this.rows - 1, this.row + 1)
      this.col = 0
      this.pendingWrap = false
    }
    if (this.row < this.rows && this.col < this.cols) this.grid[this.row]![this.col] = ch
    if (this.col >= this.cols - 1) {
      this.pendingWrap = true // stay at the last column; next glyph wraps first
    } else {
      this.col++
    }
  }

  frames(): string[][] {
    return this.snapshots.map((f) => [...f])
  }
}
