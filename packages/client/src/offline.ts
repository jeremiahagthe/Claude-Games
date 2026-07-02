import {
  BotBrain, MatchRoom, MIN_COMBATANTS, TICK_MS, handleFromSeed, MAPS, randomHandle, mulberry32,
} from '@fragwait/core'
import { hostname } from 'node:os'
import { detectColorMode, viewSize } from './caps.js'
import { FrameBuffer, TermRenderer } from './framebuffer.js'
import { KillFeed, hudRows } from './hud.js'
import { IntentTracker } from './input/intent.js'
import { KeyParser } from './input/parser.js'
import { renderView } from './raycast.js'
import { TerminalSession } from './terminal.js'

const ESC = '\x1b'

export async function runOffline(opts: { name?: string }): Promise<void> {
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
  let banner: string | null = null
  let scoreboardHeld = 0
  let quit = false

  let { viewCols, viewRows } = viewSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
  let fb = new FrameBuffer(viewCols, viewRows * 2)
  const renderer = new TermRenderer(detectColorMode(process.env))
  process.stdout.on('resize', () => {
    ;({ viewCols, viewRows } = viewSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24))
    fb = new FrameBuffer(viewCols, viewRows * 2)
    renderer.reset()
    term.write(`${ESC}[2J`)
  })

  process.stdin.on('data', (chunk: Buffer) => {
    for (const e of parser.feed(chunk)) {
      if (e.key === 'kitty-ack') intent.enableTier1()
      else if ((e.key === 'q' || e.key === 'esc' || e.key === 'ctrl-c') && e.kind === 'press') quit = true
      else if (e.key === 'enter' && banner) quit = true
      else if (e.key === 'tab') scoreboardHeld = 8 // ~400ms of scoreboard per Tab press
      else intent.onKey(e)
    }
  })

  term.enter()
  term.installExitGuards(() => {})

  let seq = 0
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (quit || room.finished) {
        clearInterval(timer)
        resolve()
        return
      }
      room.queueInput(selfId, [intent.sample(++seq)])
      for (const b of bots) room.queueInput(b.id, [b.think(room.state, room.map)])
      for (const k of room.tick()) feed.push(k, room.state)

      renderView(fb, room.map, room.state, selfId)
      let out = renderer.frame(fb)
      const { top, bottom } = hudRows(room.state, selfId, viewCols, null, feed)
      out += `${ESC}[${viewRows + 1};1H${ESC}[0;7m${top}${ESC}[0m`
      out += `${ESC}[${viewRows + 2};1H${bottom[0]}${ESC}[${viewRows + 3};1H${bottom[1]}`
      if (banner) out += `${ESC}[2;3H${ESC}[1;7m ${banner} ${ESC}[0m`
      if (scoreboardHeld-- > 0 || room.finished) out += scoreboardOverlay(room)
      term.write(out)
    }, TICK_MS)
  })

  if (room.finished) {
    term.write(`${ESC}[2J${ESC}[H` + finalScoreboard(room))
    await new Promise<void>((r) => process.stdin.once('data', () => r()))
  }
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
