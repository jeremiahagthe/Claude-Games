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
    // still delivers presses while Terminal.app delivers full motion for
    // position-based aim. SGR keeps reports parseable as plain digits instead of
    // raw coordinate bytes. (Historically this also suppressed phantom trackpad
    // scroll → arrow-key translation in the alt screen.)
    this.write(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h`)
    // Request a crosshair OS pointer over the terminal (OSC 22, kitty
    // pointer-shape protocol — iTerm2/kitty/Ghostty honor it, others ignore the
    // unknown OSC). Cursor aim means the OS pointer IS the weapon, so shape it
    // like one. Mirrored back to 'default' in restore().
    this.write(`${ESC}]22;crosshair${ESC}\\`)
  }

  restore(): void {
    if (!this.entered || this.restoredOnce) return
    this.restoredOnce = true
    // reverse order (mirrors enter()): restore the default pointer shape first
    // (mirror of the OSC 22 crosshair request); then the mouse ladder in exact
    // mirror (SGR first, then 1003 → 1002 → 1000); then kitty pop (avoid flag
    // leak — spec risk list); then cursor/alt screen.
    this.write(`${ESC}]22;default${ESC}\\`)
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
