// extracted from packages/chess-client (originally packages/client) — 2026-07-12
// MODIFIED: dropped the OSC 22 crosshair-cursor lines (both the `enter()`
// request and the mirrored restore) — chess is a point-and-click board, not
// an aim game, so the terminal keeps its normal OS pointer shape throughout.
// Everything else (alt screen, kitty push/pop, mouse ladder, focus
// reporting, restore mirroring) is unchanged.
const ESC = '\x1b'

export class TerminalSession {
  private entered = false
  private restoredOnce = false
  private guardsInstalled = false

  constructor(private stdin: NodeJS.ReadStream, private stdout: NodeJS.WriteStream) {}

  write(s: string): void {
    this.stdout.write(s)
  }

  enter(): void {
    this.entered = true
    this.restoredOnce = false
    if (this.stdin.isTTY) this.stdin.setRawMode(true)
    this.stdin.resume()
    // alt screen, hide cursor, clear; then kitty: push flags(2=event types) + query support
    this.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`)
    this.write(`${ESC}[>2u${ESC}[?u`)
    // Any-motion mouse tracking + SGR encoding. The whole ladder is requested
    // (1000 clicks → 1002 button-drag → 1003 any-motion → 1006 SGR encoding):
    // terminals honor the highest mode they support, so a click-only terminal
    // still delivers presses (square selection) while richer terminals also
    // deliver hover/drag motion for cursor-following highlights. SGR keeps
    // reports parseable as plain digits instead of raw coordinate bytes.
    this.write(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`)
    // Focus reporting (?1004): the terminal emits CSI I / CSI O on focus
    // gain/loss.
    this.write(`${ESC}[?1004h`)
  }

  restore(): void {
    if (!this.entered || this.restoredOnce) return
    this.restoredOnce = true
    // reverse order (mirrors enter()): focus reporting off first, then the
    // mouse ladder in exact mirror (SGR first, then 1003 → 1002 → 1000);
    // then kitty pop (avoid flag leak — spec risk list); then cursor/alt screen.
    this.write(`${ESC}[?1004l`) // focus reporting off (mirror of enter's ?1004h)
    this.write(`${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l`)
    this.write(`${ESC}[<u`)
    this.write(`${ESC}[0m${ESC}[?25h${ESC}[?1049l`)
    if (this.stdin.isTTY) this.stdin.setRawMode(false)
    this.stdin.pause()
  }

  installExitGuards(onExit: () => void): void {
    if (this.guardsInstalled) return
    this.guardsInstalled = true
    const bail = (code: number) => {
      this.restore()
      onExit()
      process.exit(code)
    }
    process.on('SIGINT', () => bail(0))
    process.on('SIGTERM', () => bail(0))
    process.on('uncaughtException', (err) => {
      this.restore()
      console.error(err)
      onExit()
      process.exit(1)
    })
    process.on('exit', () => this.restore())
  }
}
