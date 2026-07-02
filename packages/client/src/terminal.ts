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
  }

  restore(): void {
    if (!this.entered || this.restoredOnce) return
    this.restoredOnce = true
    // reverse order: kitty pop FIRST (avoid flag leak — spec risk list), then cursor, then alt screen
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
