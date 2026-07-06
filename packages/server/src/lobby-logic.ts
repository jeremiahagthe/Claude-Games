import { MATCH_TICKS, MAX_PLAYERS, TICK_RATE } from 'fragwait-core'

const TTL_MS = (MATCH_TICKS / TICK_RATE) * 1000 + 30_000

interface Entry { assigned: number; createdAt: number }

export class LobbyRegistry {
  private open = new Map<string, Entry>()

  register(id: string, nowMs: number): void {
    this.open.set(id, { assigned: 1, createdAt: nowMs })
  }

  assign(id: string): void {
    const e = this.open.get(id)
    if (e) e.assigned++
  }

  pick(nowMs: number, exclude?: string): string | null {
    let best: { id: string; assigned: number } | null = null
    for (const [id, e] of this.open) {
      if (nowMs - e.createdAt > TTL_MS) {
        this.open.delete(id)
        continue
      }
      if (id === exclude || e.assigned >= MAX_PLAYERS) continue
      if (!best || e.assigned > best.assigned) best = { id, assigned: e.assigned }
    }
    return best?.id ?? null
  }
}
