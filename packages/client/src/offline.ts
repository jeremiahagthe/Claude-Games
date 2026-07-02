import {
  BLASTER_COOLDOWN_TICKS, BotBrain, MatchRoom, MIN_COMBATANTS, TICK_MS, handleFromSeed, MAPS,
  randomHandle, mulberry32, wrapAngle, type MatchState, type PlayerState,
} from '@fragwait/core'
import { hostname } from 'node:os'
import { detectColorMode, viewSize } from './caps.js'
import { busyElapsedSeconds, startClaudeListener } from './claude.js'
import { FrameBuffer, TermRenderer } from './framebuffer.js'
import { drawGun } from './gun.js'
import { KillFeed, hudRows } from './hud.js'
import { IntentTracker } from './input/intent.js'
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

export async function runOffline(opts: { name?: string; mute?: boolean }): Promise<void> {
  const seedRng = mulberry32(Date.now() >>> 0)
  const map = MAPS[Math.floor(seedRng() * MAPS.length)]!
  const room = new MatchRoom(map, Math.floor(seedRng() * 2 ** 31))
  const selfId = 'human'
  const handle = opts.name ?? handleFromSeed(hostname())
  room.addPlayer(selfId, handle, false)
  const bots = Array.from({ length: MIN_COMBATANTS - 1 }, (_, i) => {
    const id = `bot${i}`
    room.addPlayer(id, `${randomHandle(seedRng)}·synth`, true)
    return new BotBrain(id, Math.floor(seedRng() * 2 ** 31))
  })

  const term = new TerminalSession(process.stdin, process.stdout)
  const parser = new KeyParser()
  const intent = new IntentTracker(() => performance.now())
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
  const renderer = new TermRenderer(detectColorMode(process.env))
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
      if (e.key === 'kitty-ack') intent.enableTier1()
      else if (e.key === 'esc' && e.kind === 'press' && banner) banner = null // dismiss banner, don't quit
      else if ((e.key === 'q' || e.key === 'esc' || e.key === 'ctrl-c') && e.kind === 'press') quit = true
      else if (e.key === 'enter' && banner) quit = true
      else if (e.key === 'tab' && e.kind !== 'release') scoreboardHeld = 8 // ~400ms of scoreboard per Tab press
      else intent.onKey(e)
    }
  }
  process.stdin.on('data', onData)

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
        if (k.victimId === selfId) sfx.play('death')
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
      const alpha = Math.min(1, Math.max(0, (performance.now() - tickAt) / TICK_MS))
      const view = interpolateState(prev, curr, alpha)
      const me = curr.players[selfId]
      const weapon: 'blaster' | 'rail' = me?.hasRail ? 'rail' : 'blaster'

      renderView(fb, room.map, view, selfId, recoil)
      drawGun(fb, weapon, recoil)
      recoil *= 0.8

      let out = renderer.frame(fb)
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
