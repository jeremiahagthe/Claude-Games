import { MAX_HP, TICK_RATE, type KillEvent, type MatchState } from 'fragwait-core'

function pad(s: string, w: number): string {
  return s.length > w ? s.slice(0, w) : s + ' '.repeat(w - s.length)
}

export class KillFeed {
  private items: string[] = []
  push(k: KillEvent, state: MatchState): void {
    const killer = state.players[k.killerId]?.handle ?? '???'
    const victim = state.players[k.victimId]?.handle ?? '???'
    this.items.push(`${killer} ${k.weapon === 'rail' ? '⌦' : '⌫'} ${victim}`)
    if (this.items.length > 3) this.items.shift()
  }
  lines(): string[] {
    return [...this.items]
  }
}

export function fmtTime(ticks: number): string {
  const s = Math.max(0, Math.ceil(ticks / TICK_RATE))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function fmtBusy(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
}

export function hudRows(
  state: MatchState,
  selfId: string,
  cols: number,
  busySeconds: number | null,
  feed: KillFeed,
): { top: string; bottom: string[] } {
  const me = state.players[selfId]
  const busy = busySeconds != null ? `  ⚙ Claude working ${fmtBusy(busySeconds)}` : ''
  const top = pad(` ${state.mapId}  ⏱ ${fmtTime(state.timeLeftTicks)}${busy}`, cols)

  const hp = me ? Math.max(0, me.hp) : 0
  const blocks = Math.round((hp / MAX_HP) * 10)
  const hpBar = `HP ${'█'.repeat(blocks)}${'░'.repeat(10 - blocks)} ${String(hp).padStart(3)}`
  const rail = me?.hasRail ? '  RAIL ✦' : ''
  const feedLines = feed.lines()
  const row1 = pad(` ${hpBar}  FRAGS ${me?.frags ?? 0}${rail}`, cols)
  const row2 = pad(` ${feedLines[feedLines.length - 1] ?? ''}`, cols)
  return { top, bottom: [row1, row2] }
}
