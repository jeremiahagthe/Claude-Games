import {
  BLASTER_COOLDOWN_TICKS, INPUT_BATCH_MS, INTERP_DELAY_MS, TICK_MS,
  handleFromSeed, mapById, quantizeInput, sanitizeHandle, wrapAngle,
  type GameMap, type KillEvent, type MatchState, type PlayerInput, type PlayerState,
} from 'fragwait-core'
import { hostname } from 'node:os'
import { detectColorMode, viewSize } from './caps.js'
import { busyElapsedSeconds, startClaudeListener } from './claude.js'
import { FrameBuffer, TermRenderer } from './framebuffer.js'
import { drawGun } from './gun.js'
import { KillFeed, hudRows } from './hud.js'
import { waitForPress } from './input/dismiss.js'
import { IntentTracker } from './input/intent.js'
import { QuitConfirm } from './input/quit.js'
import { readOsKeyTimings } from './input/os-timings.js'
import { KeyParser } from './input/parser.js'
import { createMouselock, MouselockController, type Mouselock } from './mouselock.js'
import { NetClient } from './net/client.js'
import { Interpolator } from './net/interp.js'
import { Predictor } from './net/predictor.js'
import { renderView } from './raycast.js'
import { Sfx } from './sound.js'
import { TerminalSession } from './terminal.js'

const ESC = '\x1b'
const RENDER_MS = 16 // ~60fps

// Lerps the local player between the last two 20Hz predicted states so the
// 60fps render loop looks smooth even though prediction only advances at
// TICK_MS — the same technique offline.ts applies to the whole sim, applied
// here to predictor.self alone (remote players are smoothed by Interpolator).
function lerpSelf(prev: PlayerState, curr: PlayerState, alpha: number): PlayerState {
  return {
    ...curr,
    pos: { x: prev.pos.x + (curr.pos.x - prev.pos.x) * alpha, y: prev.pos.y + (curr.pos.y - prev.pos.y) * alpha },
    dir: wrapAngle(prev.dir + wrapAngle(curr.dir - prev.dir) * alpha),
  }
}

export async function runOnline(opts: { name?: string; mute?: boolean; server: string; mouselock?: () => Mouselock }): Promise<'played' | 'unreachable'> {
  const handle = sanitizeHandle(opts.name ?? handleFromSeed(hostname()))
  let selfId = ''
  let map: GameMap | null = null
  let predictor: Predictor | null = null
  const interp = new Interpolator()
  // Two most recent authoritative snaps, kept for walk-frame motion detection
  // of remote players (Interpolator.sample returns a single blended state, so
  // motion has to be measured across the raw snaps like offline does).
  let prevSnap: MatchState | null = null
  let lastSnap: MatchState | null = null
  let ended: MatchState | null = null
  let closed = false

  // Connect BEFORE touching the terminal: an unreachable server returns here
  // with the normal screen untouched (no alt-screen flicker before the offline
  // fallback), and there is no terminal/mouselock state to clean up on failure.
  let net: NetClient
  try {
    net = await NetClient.connect(opts.server, handle, {
      onWelcome(id, state) {
        selfId = id
        map = mapById(state.mapId)
        predictor = new Predictor(state.players[id]!, map)
      },
      onSnap(state) {
        interp.push(state, performance.now())
        prevSnap = lastSnap
        lastSnap = state
        if (predictor && state.players[selfId]) predictor.onServerState(state.players[selfId]!)
      },
      onEnd(state) { ended = state },
      onClose() { closed = true },
    })
  } catch {
    return 'unreachable'
  }
  // welcome resolved connect(), so these are populated. Capture as non-null
  // consts for the loop below.
  const gameMap = map!
  const pred = predictor!
  const self = selfId

  const term = new TerminalSession(process.stdin, process.stdout)
  const parser = new KeyParser()
  const intent = new IntentTracker(() => performance.now(), { timings: readOsKeyTimings() })
  const feed = new KillFeed()
  const sfx = new Sfx({ mute: opts.mute ?? false })
  const mouselock = (opts.mouselock ?? createMouselock)()
  const mlCtl = new MouselockController(mouselock, intent, () => performance.now())
  let banner: string | null = null
  const quitConfirm = new QuitConfirm(() => performance.now())
  let scoreboardHeld = 0
  let quit = false
  let finished = false

  const listener = await startClaudeListener()
  listener.onEvent((event) => {
    banner = event === 'done'
      ? '✔ Claude is done — Enter: quit & return · Esc: dismiss'
      : '⚠ Claude needs your input — Enter: quit & return'
    sfx.play('banner')
  })

  let { viewCols, viewRows } = viewSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
  let fb = new FrameBuffer(viewCols, viewRows * 2)
  const colorMode = detectColorMode(process.env)
  const renderer = new TermRenderer(colorMode)
  let pointer: { x: number; y: number } | null = null
  const finalState = (): MatchState | null => ended ?? lastSnap
  const onResize = () => {
    ;({ viewCols, viewRows } = viewSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24))
    fb = new FrameBuffer(viewCols, viewRows * 2)
    renderer.reset()
    term.write(`${ESC}[2J`)
    const fs = finalState()
    if (finished && fs) term.write(`${ESC}[2J${ESC}[H` + finalScoreboard(fs))
  }
  process.stdout.on('resize', onResize)

  const onData = (chunk: Buffer) => {
    for (const e of parser.feed(chunk)) {
      if ('type' in e) {
        pointer = { x: e.x, y: e.y }
        intent.onMouseMotion(e.x, e.y, viewCols, viewRows)
        mlCtl.onMouseEvent(e.x, e.y)
        if (e.button === 'left' || e.button === 'right' || e.button === 'middle') {
          intent.onMouseButton(e.button, e.action)
        }
        continue
      }
      if (e.key === 'kitty-ack') intent.enableTier1()
      else if (e.key === 'focus-in' && e.kind === 'press') mlCtl.onFocusIn()
      else if (e.key === 'focus-out' && e.kind === 'press') mlCtl.onFocusOut()
      else if (e.key === 'm' && e.kind === 'press') mlCtl.toggleLock()
      else if (e.key === 'ctrl-c' && e.kind === 'press') quit = true // instant escape hatch
      else if (e.key === 'esc' && e.kind === 'press' && banner && !quitConfirm.armed) banner = null // dismiss banner, don't quit
      // Feel-12: Q/Esc (and Enter while the banner offers quit & return) arm a
      // confirm window instead of quitting outright — a second press inside it
      // quits. Kills the fat-fingered-Q instant match loss (Q is next to W and
      // the pointer is hidden in mouselock).
      else if ((e.key === 'q' || e.key === 'esc') && e.kind === 'press') quit = quitConfirm.request()
      else if (e.key === 'enter' && e.kind === 'press' && banner) quit = quitConfirm.request()
      else if (e.key === 'tab' && e.kind !== 'release') scoreboardHeld = 8 // ~400ms of scoreboard per Tab press
      else intent.onKey(e)
    }
  }
  process.stdin.on('data', onData)

  if (process.platform === 'darwin') {
    process.stdout.write(
      `${ESC}[2maim: move mouse (mouse-look) · walk: hold right mouse or W · fire: click or Space · M toggles lock · Q quits${ESC}[0m\n`,
    )
  }

  term.enter()
  // leave the match AND dispose the mouselock helper on every abnormal exit
  // path (signals / uncaught), alongside the terminal restore.
  term.installExitGuards(() => { net.leave(); mouselock.dispose() })

  let seq = 0
  let busySeconds: number | null = null
  let lastBusyPoll = 0
  let recoil = 0
  const batch: PlayerInput[] = []
  let lastFlushAt = performance.now()
  let selfPrev = structuredClone(pred.self)
  let selfCurr = structuredClone(pred.self)
  let selfTickAt = performance.now()

  // Kills are surfaced from each render's interpolated base.kills; the same
  // kill event repeats across ~6 render frames until the next snap replaces it,
  // so dedup on `${tick}:${victimId}` before pushing to the feed / playing SFX.
  const seenKills = new Set<string>()
  const feedPushOnce = (k: KillEvent, state: MatchState) => {
    const key = `${k.tick}:${k.victimId}`
    if (seenKills.has(key)) return
    seenKills.add(key)
    feed.push(k, state)
    if (k.killerId === self) sfx.play('kill')
    if (k.victimId === self) {
      sfx.play('death')
      intent.resetTransient() // a respawn must not drain stale turn budget/holds
    }
  }

  await new Promise<void>((resolve) => {
    const simTimer = setInterval(() => {
      if (quit || ended || closed) {
        clearInterval(simTimer)
        clearInterval(renderTimer)
        resolve()
        return
      }
      const now = performance.now()
      // Quantize once, at sample time, so the predicted local state is stepped
      // with the exact same input the server receives (keeps reconciliation
      // drift sub-quantum). quantizeInput before sendInputs is its purpose.
      const input = quantizeInput(intent.sample(++seq))
      pred.applyLocal(input)
      batch.push(input)
      if (now - lastFlushAt >= INPUT_BATCH_MS) {
        net.sendInputs(batch.splice(0))
        lastFlushAt = now
      }

      if (now - lastBusyPoll > 1000) {
        busySeconds = busyElapsedSeconds()
        lastBusyPoll = now
      }
      if (scoreboardHeld > 0) scoreboardHeld--

      selfPrev = selfCurr
      selfCurr = structuredClone(pred.self)
      selfTickAt = now
      if (selfCurr.fireCooldown === BLASTER_COOLDOWN_TICKS) {
        recoil = 1
        sfx.play('fire')
      }
      if (!selfPrev.hasRail && selfCurr.hasRail) sfx.play('pickup')
    }, TICK_MS)

    const renderTimer = setInterval(() => {
      const now = performance.now()
      const view = interp.sample(now - INTERP_DELAY_MS)
      if (!view) return
      // Replace the local player with the smoothed prediction (server-agreed
      // position, no interp delay applied to self).
      const alpha = Math.min(1, Math.max(0, (now - selfTickAt) / TICK_MS))
      view.players[self] = lerpSelf(selfPrev, selfCurr, alpha)
      const me = view.players[self]!
      const weapon: 'blaster' | 'rail' = me.hasRail ? 'rail' : 'blaster'

      const moving: Record<string, boolean> = {}
      for (const id of Object.keys(view.players)) {
        if (id === self) {
          moving[id] = Math.hypot(selfCurr.pos.x - selfPrev.pos.x, selfCurr.pos.y - selfPrev.pos.y) > 0.01
          continue
        }
        const p = prevSnap?.players[id]
        const c = lastSnap?.players[id]
        moving[id] = p && c ? Math.hypot(c.pos.x - p.pos.x, c.pos.y - p.pos.y) > 0.01 : false
      }

      const crosshair = mlCtl.mode === 'mouselock' ? null : pointer
      renderView(fb, gameMap, view, self, recoil, { now, moving, pointer: crosshair })
      drawGun(fb, weapon, recoil)
      recoil *= 0.8

      for (const k of view.kills) feedPushOnce(k, view)

      let out = renderer.frame(fb)
      const { top, bottom } = hudRows(view, self, viewCols, busySeconds, feed)
      out += `${ESC}[${viewRows + 1};1H${ESC}[0;7m${top}${ESC}[0m`
      out += `${ESC}[${viewRows + 2};1H${bottom[0]}${ESC}[${viewRows + 3};1H${bottom[1]}`
      if (quitConfirm.armed) out += `${ESC}[2;3H${ESC}[1;7m press again to quit ${ESC}[0m`
      else if (banner) out += `${ESC}[2;3H${ESC}[1;7m ${banner} ${ESC}[0m`
      const fs = finalState()
      if ((scoreboardHeld > 0 || ended || closed) && fs) out += scoreboardOverlay(fs)
      term.write(out)
    }, RENDER_MS)
  })

  process.stdin.off('data', onData)
  const fs = finalState()
  if ((ended || closed) && fs) {
    finished = true
    term.write(`${ESC}[2J${ESC}[H` + finalScoreboard(fs))
    // M1: only a real key/button press dismisses — never mouse motion, focus
    // changes, or the release of a key held when the match ended.
    await waitForPress(process.stdin, parser)
  }
  process.stdout.off('resize', onResize)
  await listener.close()
  net.leave() // best-effort; harmless if the server already closed us
  mouselock.dispose()
  term.restore()
  process.exit(0)
}

function scoreboardOverlay(state: MatchState): string {
  const rows = Object.values(state.players).sort((a, b) => b.frags - a.frags)
  let s = `${ESC}[4;5H${ESC}[7m  SCOREBOARD                    ${ESC}[0m`
  rows.forEach((p, i) => {
    s += `${ESC}[${5 + i};5H${ESC}[7m  ${String(p.frags).padStart(3)}  ${p.handle.padEnd(24)}  ${ESC}[0m`
  })
  return s
}

function finalScoreboard(state: MatchState): string {
  const rows = Object.values(state.players).sort((a, b) => b.frags - a.frags)
  const lines = ['', '  MATCH OVER — press any key', '']
  rows.forEach((p, i) => lines.push(`   ${i + 1}. ${String(p.frags).padStart(3)}  ${p.handle}`))
  return lines.join('\r\n')
}
