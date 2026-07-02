import {
  BLASTER_COOLDOWN_TICKS, BotBrain, DIFFICULTY_SKILLS, MatchRoom, MIN_COMBATANTS, TICK_MS, handleFromSeed, MAPS,
  randomHandle, mulberry32, wrapAngle, type Difficulty, type MatchState, type PlayerState,
} from '@fragwait/core'
import { hostname } from 'node:os'
import { detectColorMode, viewSize } from './caps.js'
import { busyElapsedSeconds, startClaudeListener } from './claude.js'
import { FrameBuffer, TermRenderer, rgbTo256 } from './framebuffer.js'
import { drawGun } from './gun.js'
import { KillFeed, hudRows } from './hud.js'
import { IntentTracker } from './input/intent.js'
import { readOsKeyTimings } from './input/os-timings.js'
import { KeyParser } from './input/parser.js'
import { renderView } from './raycast.js'
import { Sfx } from './sound.js'
import { TerminalSession } from './terminal.js'

const ESC = '\x1b'
const RENDER_MS = 16 // ~60fps

// Lerps player positions/facing between the last two 20Hz sim snapshots so the
// 60fps render loop looks smooth even though the simulation only advances at
// TICK_MS. Players present in both snapshots are interpolated; players only
// present in curr (e.g. a fresh join) render at their curr position directly.
function interpolateState(prev: MatchState, curr: MatchState, alpha: number): MatchState {
  const players: Record<string, PlayerState> = {}
  for (const [id, c] of Object.entries(curr.players)) {
    const p = prev.players[id]
    if (!p) {
      players[id] = c
      continue
    }
    players[id] = {
      ...c,
      pos: { x: p.pos.x + (c.pos.x - p.pos.x) * alpha, y: p.pos.y + (c.pos.y - p.pos.y) * alpha },
      dir: wrapAngle(p.dir + wrapAngle(c.dir - p.dir) * alpha),
    }
  }
  return { ...curr, players }
}

export async function runOffline(opts: { name?: string; mute?: boolean; difficulty?: Difficulty }): Promise<void> {
  const seedRng = mulberry32(Date.now() >>> 0)
  const map = MAPS[Math.floor(seedRng() * MAPS.length)]!
  const room = new MatchRoom(map, Math.floor(seedRng() * 2 ** 31))
  const selfId = 'human'
  const handle = opts.name ?? handleFromSeed(hostname())
  room.addPlayer(selfId, handle, false)
  const skills = DIFFICULTY_SKILLS[opts.difficulty ?? 'normal']
  const bots = Array.from({ length: MIN_COMBATANTS - 1 }, (_, i) => {
    const id = `bot${i}`
    room.addPlayer(id, `${randomHandle(seedRng)}·synth`, true)
    return new BotBrain(id, Math.floor(seedRng() * 2 ** 31), skills[i])
  })

  const term = new TerminalSession(process.stdin, process.stdout)
  const parser = new KeyParser()
  // Measured once at startup and injected: tier-2 inference derives all of
  // its hold/phase windows from the host's real key-repeat timings (F1).
  const intent = new IntentTracker(() => performance.now(), { timings: readOsKeyTimings() })
  const feed = new KillFeed()
  const sfx = new Sfx({ mute: opts.mute ?? false })
  let banner: string | null = null
  let scoreboardHeld = 0
  let quit = false
  let ended = false

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
  // A single foreground-colored glyph in the active color mode (mono: bare
  // glyph). Used for the aim indicator overlay, cursor-addressed like the HUD.
  const fgGlyph = (ch: string, r: number, g: number, b: number): string =>
    colorMode === 'truecolor'
      ? `${ESC}[38;2;${r};${g};${b}m${ch}${ESC}[0m`
      : colorMode === '256'
        ? `${ESC}[38;5;${rgbTo256(r, g, b)}m${ch}${ESC}[0m`
        : ch
  // Last known pointer offset from view center in [-1, 1] (null until first
  // mouse move); the indicator column is derived from it each frame so it stays
  // correct across resizes. Aim geometry is owned here, not in the tracker.
  let pointerNormX: number | null = null
  const onResize = () => {
    ;({ viewCols, viewRows } = viewSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24))
    fb = new FrameBuffer(viewCols, viewRows * 2)
    renderer.reset()
    term.write(`${ESC}[2J`)
    if (ended) term.write(`${ESC}[2J${ESC}[H` + finalScoreboard(room))
  }
  process.stdout.on('resize', onResize)

  const onData = (chunk: Buffer) => {
    for (const e of parser.feed(chunk)) {
      if ('type' in e) {
        // Mouse: every report updates aim (joystick position → turn rate);
        // recompute geometry from the current viewCols so resize stays correct.
        const center = (viewCols + 1) / 2
        const halfWidth = viewCols / 2
        pointerNormX = Math.max(-1, Math.min(1, (e.x - center) / halfWidth))
        intent.onMouseMove(pointerNormX)
        if (e.button === 'left') intent.onMouseButton(e.button, e.action)
        continue
      }
      if (e.key === 'kitty-ack') intent.enableTier1()
      else if (e.key === 'esc' && e.kind === 'press' && banner) banner = null // dismiss banner, don't quit
      else if ((e.key === 'q' || e.key === 'esc' || e.key === 'ctrl-c') && e.kind === 'press') quit = true
      else if (e.key === 'enter' && banner) quit = true
      else if (e.key === 'tab' && e.kind !== 'release') scoreboardHeld = 8 // ~400ms of scoreboard per Tab press
      else intent.onKey(e)
    }
  }
  process.stdin.on('data', onData)

  // Startup hint, printed BEFORE the alt screen so it survives on the normal
  // screen after exit. The kitty probe only answers once the session is live,
  // so tier can't be known yet — the "tap opposite to stop" latch semantics are
  // tier-2-specific (kitty-class terminals move on real key-hold), so the hint
  // stays darwin-gated at the common Apple-Terminal/tier-2 case. Non-blocking:
  // one dim line, no prompt.
  if (process.platform === 'darwin') {
    process.stdout.write(
      `${ESC}[2maim: move mouse left/right of center · fire: click (or Space) · move: tap W/A/S/D (tap opposite to stop) · Q quits${ESC}[0m\n`,
    )
  }

  term.enter()
  term.installExitGuards(() => {})

  let seq = 0
  let busySeconds: number | null = null
  let lastBusyPoll = 0
  let recoil = 0
  let prev: MatchState = structuredClone(room.state)
  let curr: MatchState = structuredClone(room.state)
  let tickAt = performance.now()

  await new Promise<void>((resolve) => {
    const simTimer = setInterval(() => {
      if (quit || room.finished) {
        clearInterval(simTimer)
        clearInterval(renderTimer)
        resolve()
        return
      }
      room.queueInput(selfId, [intent.sample(++seq)])
      for (const b of bots) room.queueInput(b.id, [b.think(room.state, room.map)])
      for (const k of room.tick()) {
        feed.push(k, room.state)
        if (k.killerId === selfId) sfx.play('kill')
        if (k.victimId === selfId) {
          sfx.play('death')
          // a respawn must not drain stale turn budget/holds into the new facing
          intent.resetTransient()
        }
      }

      if (performance.now() - lastBusyPoll > 1000) {
        busySeconds = busyElapsedSeconds()
        lastBusyPoll = performance.now()
      }
      if (scoreboardHeld > 0) scoreboardHeld--

      prev = curr
      curr = structuredClone(room.state)
      tickAt = performance.now()

      const meCurr = curr.players[selfId]
      const mePrev = prev.players[selfId]
      if (meCurr) {
        if (meCurr.fireCooldown === BLASTER_COOLDOWN_TICKS) {
          recoil = 1
          sfx.play('fire')
        }
        if (mePrev && !mePrev.hasRail && meCurr.hasRail) sfx.play('pickup')
      }
    }, TICK_MS)

    const renderTimer = setInterval(() => {
      const now = performance.now()
      const alpha = Math.min(1, Math.max(0, (now - tickAt) / TICK_MS))
      const view = interpolateState(prev, curr, alpha)
      const me = curr.players[selfId]
      const weapon: 'blaster' | 'rail' = me?.hasRail ? 'rail' : 'blaster'

      // Motion is detected across the last two SIM snapshots (where both are
      // visible), not inside the renderer — a moving enemy alternates walk frames.
      const moving: Record<string, boolean> = {}
      for (const [id, c] of Object.entries(curr.players)) {
        const p = prev.players[id]
        moving[id] = p ? Math.hypot(c.pos.x - p.pos.x, c.pos.y - p.pos.y) > 0.01 : false
      }

      renderView(fb, room.map, view, selfId, recoil, { now, moving })
      drawGun(fb, weapon, recoil)
      recoil *= 0.8

      let out = renderer.frame(fb)
      // Aim indicator on the top view row (row 1), repainted unconditionally
      // every frame like the HUD so it survives the diff renderer: a dim gray
      // '+' marks view center, a bright ▼ marks the pointer (pointer wins a
      // shared cell — drawn last). Geometry recomputed from viewCols each frame.
      const center = (viewCols + 1) / 2
      out += `${ESC}[1;${Math.round(center)}H` + fgGlyph('+', 120, 120, 120)
      if (pointerNormX !== null) {
        const col = Math.max(1, Math.min(viewCols, Math.round(center + pointerNormX * (viewCols / 2))))
        out += `${ESC}[1;${col}H` + fgGlyph('▼', 255, 220, 120)
      }
      const { top, bottom } = hudRows(curr, selfId, viewCols, busySeconds, feed)
      out += `${ESC}[${viewRows + 1};1H${ESC}[0;7m${top}${ESC}[0m`
      out += `${ESC}[${viewRows + 2};1H${bottom[0]}${ESC}[${viewRows + 3};1H${bottom[1]}`
      if (banner) out += `${ESC}[2;3H${ESC}[1;7m ${banner} ${ESC}[0m`
      if (scoreboardHeld > 0 || room.finished) out += scoreboardOverlay(room)
      term.write(out)
    }, RENDER_MS)
  })

  process.stdin.off('data', onData)
  if (room.finished) {
    ended = true
    term.write(`${ESC}[2J${ESC}[H` + finalScoreboard(room))
    await new Promise<void>((r) => process.stdin.once('data', () => r()))
  }
  process.stdout.off('resize', onResize)
  await listener.close()
  term.restore()
  process.exit(0)
}

function scoreboardOverlay(room: MatchRoom): string {
  const rows = Object.values(room.state.players).sort((a, b) => b.frags - a.frags)
  let s = `${ESC}[4;5H${ESC}[7m  SCOREBOARD                    ${ESC}[0m`
  rows.forEach((p, i) => {
    s += `${ESC}[${5 + i};5H${ESC}[7m  ${String(p.frags).padStart(3)}  ${p.handle.padEnd(24)}  ${ESC}[0m`
  })
  return s
}

function finalScoreboard(room: MatchRoom): string {
  const rows = Object.values(room.state.players).sort((a, b) => b.frags - a.frags)
  const lines = ['', '  MATCH OVER — press any key', '']
  rows.forEach((p, i) => lines.push(`   ${i + 1}. ${String(p.frags).padStart(3)}  ${p.handle}`))
  return lines.join('\r\n')
}
