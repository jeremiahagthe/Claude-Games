import {
  BotBrain, DIFFICULTY_SKILLS, MatchRoom, MAPS, MAX_PLAYERS, MIN_COMBATANTS, mulberry32,
  parseClientMsg, randomHandle, type ServerMsg,
} from '@fragwait/core'

// Online backfill bots are placeholders for humans, not the opposition: they
// must be beatable by a first-time player, so they draw from the easy tier
// (BotBrain's default 0.45 sits between offline "normal" and "hard").
const BOT_SKILLS = DIFFICULTY_SKILLS.easy

export interface ClientConn { send(data: string): void; close(): void }

export class MatchHost {
  private room: MatchRoom
  private conns = new Map<string, ClientConn>()
  private brains = new Map<string, BotBrain>()
  private rng: () => number
  private nextId = 0

  constructor(seed: number) {
    this.rng = mulberry32(seed)
    this.room = new MatchRoom(MAPS[Math.floor(this.rng() * MAPS.length)]!, Math.floor(this.rng() * 2 ** 31))
    this.syncBots()
  }

  humanCount(): number {
    return this.room.humanCount()
  }

  join(conn: ClientConn, handle: string): string | null {
    if (this.humanCount() >= MAX_PLAYERS) return null
    if (this.room.playerCount() >= MAX_PLAYERS) this.evictOneBot()
    const id = `p${this.nextId++}`
    this.room.addPlayer(id, handle, false)
    this.conns.set(id, conn)
    this.syncBots()
    this.send(conn, { t: 'welcome', id, state: this.room.state })
    return id
  }

  handleMessage(id: string, raw: string): void {
    const msg = parseClientMsg(raw)
    if (!msg) return
    if (msg.t === 'input') this.room.queueInput(id, msg.inputs)
    else if (msg.t === 'leave') this.leave(id)
  }

  leave(id: string): void {
    this.conns.get(id)?.close()
    this.conns.delete(id)
    if (this.room.state.players[id]) this.room.removePlayer(id)
    if (this.humanCount() > 0) this.syncBots()
  }

  tick(): 'running' | 'ended' | 'empty' {
    if (this.humanCount() === 0) return 'empty'
    for (const [id, brain] of this.brains) this.room.queueInput(id, [brain.think(this.room.state, this.room.map)])
    this.room.tick()
    const msg: ServerMsg = this.room.finished ? { t: 'end', state: this.room.state } : { t: 'snap', state: this.room.state }
    for (const conn of this.conns.values()) this.send(conn, msg)
    if (this.room.finished) {
      for (const conn of this.conns.values()) conn.close()
      return 'ended'
    }
    return 'running'
  }

  private send(conn: ClientConn, msg: ServerMsg): void {
    try { conn.send(JSON.stringify(msg)) } catch { /* dead socket: cleaned up on close event */ }
  }

  private evictOneBot(): void {
    const botId = [...this.brains.keys()].pop()
    if (!botId) return
    this.brains.delete(botId)
    this.room.removePlayer(botId)
  }

  private syncBots(): void {
    const target = Math.min(MAX_PLAYERS, Math.max(MIN_COMBATANTS, this.humanCount()))
    while (this.room.playerCount() > target && this.brains.size > 0) this.evictOneBot()
    while (this.room.playerCount() < target) {
      const id = `b${this.nextId++}`
      this.room.addPlayer(id, `${randomHandle(this.rng)}·synth`, true)
      this.brains.set(id, new BotBrain(id, Math.floor(this.rng() * 2 ** 31), BOT_SKILLS[this.brains.size % BOT_SKILLS.length]!))
    }
  }
}
