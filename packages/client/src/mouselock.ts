import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Resolve the helper script path via fileURLToPath — NEVER url.pathname, which
// leaves %20 in paths containing a space (this repo's path does) and breaks the
// spawn.
const HELPER_PATH = fileURLToPath(new URL('../scripts/mouselock-helper.py', import.meta.url))

// A spawner seam so tests can inject a fake child without touching a real
// process. Mirrors the sound-spawner injectable-dependency pattern.
export type MouselockSpawner = (cmd: string, args: string[]) => ChildProcess

export interface Mouselock {
  /** false on non-darwin or spawn failure — every method is then a safe no-op. */
  readonly available: boolean
  hide(): void
  show(): void
  setpin(): void
  warp(): void
  dispose(): void
}

export interface MouselockOpts {
  platform?: string
  spawner?: MouselockSpawner
}

// Spawns the macOS mouselock helper (python3 + the helper script) and exposes
// the line protocol as method calls. On non-darwin, a spawn error, or once
// disposed, every method is a no-op and `available` is false — the helper is a
// graceful enhancement, exactly like the afplay sound spawner, and NEVER throws.
export function createMouselock(opts: MouselockOpts = {}): Mouselock {
  const platform = opts.platform ?? process.platform
  const spawner: MouselockSpawner =
    opts.spawner ?? ((cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] }))

  if (platform !== 'darwin') return unavailable()

  let child: ChildProcess
  try {
    child = spawner('python3', [HELPER_PATH])
  } catch {
    return unavailable()
  }

  // A spawn that fails asynchronously (ENOENT: no python3) emits 'error'. Latch
  // it so every subsequent write becomes a no-op instead of throwing on a dead
  // stdin.
  let ok = true
  child.on('error', () => { ok = false })

  const send = (line: string): void => {
    if (!ok || !child.stdin || child.stdin.destroyed) return
    try {
      child.stdin.write(`${line}\n`)
    } catch {
      // EPIPE (helper exited) and any other write error: swallow — a dead helper
      // means the OS already restored the cursor.
      ok = false
    }
  }

  return {
    available: true,
    hide: () => send('hide'),
    show: () => send('show'),
    setpin: () => send('setpin'),
    warp: () => send('warp'),
    dispose: () => {
      // Belt: ask the helper to show the cursor, end its stdin (EOF → clean
      // exit + its own show), then kill it. Any of these throwing must not
      // escape dispose (it runs on the terminal-restore/exit path).
      send('show')
      ok = false
      try { child.stdin?.end() } catch { /* already gone */ }
      try { child.kill() } catch { /* already gone */ }
    },
  }
}

// Pointer drifts this far (in terminal cells) from the engage-time pin before
// the game silently warps it back to the pin, keeping the hidden pointer from
// ever reaching a screen edge where the OS would clamp it and stall the deltas.
export const WARP_THRESH_COLS = 10
export const WARP_THRESH_ROWS = 5
// After a warp, the intent tracker ignores deltas this long (ms) so the warp
// teleport is not misread as look input.
export const WARP_IGNORE_MS = 60

// The slice of IntentTracker the controller drives (kept minimal so the state
// machine is unit-testable against a fake).
export interface MouselockIntent {
  setAimMode(mode: 'mouselock' | 'cursor'): void
  ignoreDeltasUntil(nowMs: number): void
}

// The aim-mode state machine (extracted from offline.ts so it is unit-testable).
// Start cursor. When the helper is available and lock is enabled (default ON),
// ENGAGE on the first mouse event (pointer now known to be inside the window):
// setpin THEN hide, switch intent to mouselock. While engaged, warp the pinned
// pointer back whenever it drifts past the threshold. focus-out / M-off / dispose
// release it. `mode` tells offline how to plumb the crosshair (mouselock →
// center reticle, pointer hidden; cursor → pointer-cell crosshair).
export class MouselockController {
  private engaged = false
  private enabled: boolean
  private focused = true
  private pinCell: { x: number; y: number } | null = null

  constructor(
    private lock: Mouselock,
    private intent: MouselockIntent,
    private now: () => number,
  ) {
    this.enabled = lock.available // default ON when the helper is available
    this.intent.setAimMode('cursor')
  }

  get mode(): 'mouselock' | 'cursor' {
    return this.engaged ? 'mouselock' : 'cursor'
  }

  onMouseEvent(x: number, y: number): void {
    if (!this.engaged) {
      if (this.lock.available && this.enabled && this.focused) this.engage(x, y)
      return
    }
    const pin = this.pinCell!
    if (Math.abs(x - pin.x) >= WARP_THRESH_COLS || Math.abs(y - pin.y) >= WARP_THRESH_ROWS) {
      this.lock.warp()
      this.intent.ignoreDeltasUntil(this.now() + WARP_IGNORE_MS)
    }
  }

  onFocusIn(): void {
    this.focused = true // re-engage happens on the next mouse event
  }

  onFocusOut(): void {
    this.focused = false
    if (this.engaged) this.disengage()
    else this.lock.show()
  }

  // M/m toggle. Disabling shows the cursor and drops to cursor mode; enabling
  // re-engages on the next mouse event.
  toggleLock(): void {
    this.enabled = !this.enabled
    if (this.enabled) return
    if (this.engaged) this.disengage()
    else this.lock.show()
  }

  dispose(): void {
    this.lock.dispose()
  }

  private engage(x: number, y: number): void {
    this.lock.setpin()
    this.lock.hide()
    this.pinCell = { x, y }
    this.engaged = true
    this.intent.setAimMode('mouselock')
  }

  private disengage(): void {
    this.lock.show()
    this.engaged = false
    this.pinCell = null
    this.intent.setAimMode('cursor')
  }
}

function unavailable(): Mouselock {
  return {
    available: false,
    hide() {}, show() {}, setpin() {}, warp() {}, dispose() {},
  }
}
