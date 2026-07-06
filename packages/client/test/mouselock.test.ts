import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  createMouselock, MouselockController, WARP_IGNORE_MS,
  type Mouselock, type MouselockIntent,
} from '../src/mouselock.js'

// --- Fakes ------------------------------------------------------------------

function fakeChild() {
  const writes: string[] = []
  const errHandlers: Array<(e: unknown) => void> = []
  const state = { ended: false, killed: false, throwOnWrite: false }
  const child = {
    stdin: {
      destroyed: false,
      write: (s: string) => {
        if (state.throwOnWrite) throw new Error('EPIPE')
        writes.push(s)
        return true
      },
      end: () => { state.ended = true },
    },
    on: (ev: string, cb: (e: unknown) => void) => {
      if (ev === 'error') errHandlers.push(cb)
      return child
    },
    kill: () => { state.killed = true; return true },
  }
  return {
    child: child as unknown as ChildProcess,
    writes,
    state,
    emitError: (e: unknown) => { for (const h of errHandlers) h(e) },
  }
}

// --- createMouselock (spawn seam) -------------------------------------------

describe('createMouselock', () => {
  it('non-darwin: available is false and every method is a no-op that never throws', () => {
    let spawned = false
    const ml = createMouselock({ platform: 'linux', spawner: () => { spawned = true; return {} as ChildProcess } })
    expect(ml.available).toBe(false)
    expect(() => { ml.hide(); ml.show(); ml.setpin(); ml.warp(); ml.dispose() }).not.toThrow()
    expect(spawned).toBe(false) // never even attempts to spawn off-darwin
  })

  it('a synchronous spawn failure degrades to unavailable, never throws', () => {
    const ml = createMouselock({ platform: 'darwin', spawner: () => { throw new Error('ENOENT') } })
    expect(ml.available).toBe(false)
    expect(() => ml.hide()).not.toThrow()
  })

  it('writes the exact protocol line for each method', () => {
    const f = fakeChild()
    const ml = createMouselock({ platform: 'darwin', spawner: () => f.child })
    expect(ml.available).toBe(true)
    ml.setpin(); ml.hide(); ml.warp(); ml.show()
    expect(f.writes).toEqual(['setpin\n', 'hide\n', 'warp\n', 'show\n'])
  })

  it('dispose writes show, ends stdin, and kills the child', () => {
    const f = fakeChild()
    const ml = createMouselock({ platform: 'darwin', spawner: () => f.child })
    ml.dispose()
    expect(f.writes).toEqual(['show\n'])
    expect(f.state.ended).toBe(true)
    expect(f.state.killed).toBe(true)
  })

  it('an async spawn error latches every later write to a no-op', () => {
    const f = fakeChild()
    const ml = createMouselock({ platform: 'darwin', spawner: () => f.child })
    f.emitError(new Error('spawn python3 ENOENT'))
    ml.hide()
    expect(f.writes).toEqual([]) // nothing written after the error
  })

  it('a write EPIPE (dead helper) is swallowed and disables further writes', () => {
    const f = fakeChild()
    const ml = createMouselock({ platform: 'darwin', spawner: () => f.child })
    f.state.throwOnWrite = true
    expect(() => ml.hide()).not.toThrow()
    f.state.throwOnWrite = false
    ml.show()
    expect(f.writes).toEqual([]) // latched off after the EPIPE
  })
})

// --- MouselockController (aim-mode state machine) ---------------------------

function fakeLock(available = true) {
  const calls: string[] = []
  const lock: Mouselock = {
    available,
    hide: () => calls.push('hide'),
    show: () => calls.push('show'),
    setpin: () => calls.push('setpin'),
    warp: () => calls.push('warp'),
    dispose: () => calls.push('dispose'),
  }
  return { lock, calls }
}

function fakeIntent() {
  const modes: string[] = []
  const state = { ignoredUntil: -1, mouseButtonsReleased: 0 }
  const intent: MouselockIntent = {
    setAimMode: (m) => modes.push(m),
    ignoreDeltasUntil: (n) => { state.ignoredUntil = n },
    releaseMouseButtons: () => { state.mouseButtonsReleased++ },
  }
  return { intent, modes, state }
}

describe('MouselockController', () => {
  it('starts in cursor mode and sets the tracker to cursor', () => {
    const l = fakeLock()
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 0)
    expect(c.mode).toBe('cursor')
    expect(i.modes).toEqual(['cursor'])
  })

  it('engages on the FIRST mouse event: setpin BEFORE hide, switch to mouselock', () => {
    const l = fakeLock()
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 0)
    c.onMouseEvent(30, 10)
    expect(l.calls).toEqual(['setpin', 'hide'])
    expect(c.mode).toBe('mouselock')
    expect(i.modes).toEqual(['cursor', 'mouselock'])
  })

  it('never engages when the helper is unavailable', () => {
    const l = fakeLock(false)
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 0)
    c.onMouseEvent(30, 10)
    expect(l.calls).toEqual([])
    expect(c.mode).toBe('cursor')
  })

  it('warps + ignores deltas when the pointer drifts ≥10 cols from the pin', () => {
    const l = fakeLock()
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 200)
    c.onMouseEvent(30, 10) // engage; pin = (30,10)
    l.calls.length = 0
    c.onMouseEvent(41, 10) // |11| ≥ 10
    expect(l.calls).toEqual(['warp'])
    expect(i.state.ignoredUntil).toBe(200 + WARP_IGNORE_MS)
  })

  it('warps when the pointer drifts ≥5 rows from the pin', () => {
    const l = fakeLock()
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 0)
    c.onMouseEvent(30, 10)
    l.calls.length = 0
    c.onMouseEvent(30, 16) // |6| ≥ 5
    expect(l.calls).toEqual(['warp'])
  })

  it('does NOT warp within the threshold', () => {
    const l = fakeLock()
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 0)
    c.onMouseEvent(30, 10)
    l.calls.length = 0
    c.onMouseEvent(38, 13) // |8| < 10, |3| < 5
    expect(l.calls).toEqual([])
  })

  it('focus-out shows the cursor and drops to cursor mode; re-engage needs focus-in + a mouse event', () => {
    const l = fakeLock()
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 0)
    c.onMouseEvent(30, 10) // engaged
    l.calls.length = 0
    c.onFocusOut()
    expect(l.calls).toEqual(['show'])
    expect(c.mode).toBe('cursor')
    expect(i.state.mouseButtonsReleased).toBe(1) // held walk/fire can never see a release while unfocused
    // a mouse event while unfocused must not re-engage
    c.onMouseEvent(30, 10)
    expect(c.mode).toBe('cursor')
    // focus-in then a mouse event re-engages (setpin + hide again)
    c.onFocusIn()
    l.calls.length = 0
    c.onMouseEvent(30, 10)
    expect(l.calls).toEqual(['setpin', 'hide'])
    expect(c.mode).toBe('mouselock')
  })

  it('M toggle: off shows + cursor mode; on re-engages on the next mouse event', () => {
    const l = fakeLock()
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 0)
    c.onMouseEvent(30, 10) // engaged
    l.calls.length = 0
    c.toggleLock() // disable
    expect(l.calls).toEqual(['show'])
    expect(c.mode).toBe('cursor')
    c.onMouseEvent(30, 10) // disabled: stays cursor
    expect(c.mode).toBe('cursor')
    c.toggleLock() // enable
    l.calls.length = 0
    c.onMouseEvent(30, 10) // re-engage
    expect(l.calls).toEqual(['setpin', 'hide'])
    expect(c.mode).toBe('mouselock')
  })

  it('dispose delegates to the lock', () => {
    const l = fakeLock()
    const i = fakeIntent()
    const c = new MouselockController(l.lock, i.intent, () => 0)
    c.dispose()
    expect(l.calls).toEqual(['dispose'])
  })
})

// --- Helper script compiles (darwin + python3 only) -------------------------

const HELPER = fileURLToPath(new URL('../scripts/mouselock-helper.py', import.meta.url))
const hasPython3 = process.platform === 'darwin' && spawnSync('python3', ['--version']).status === 0

describe('mouselock-helper.py', () => {
  it.skipIf(!hasPython3)('compiles cleanly under python3 -m py_compile', () => {
    const r = spawnSync('python3', ['-m', 'py_compile', HELPER])
    expect(r.status).toBe(0)
  })
})
