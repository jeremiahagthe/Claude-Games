import { spawn } from 'node:child_process'

export type SfxEvent = 'fire' | 'kill' | 'death' | 'pickup' | 'banner'

const SOUND_FILES: Record<SfxEvent, string> = {
  fire: '/System/Library/Sounds/Tink.aiff',
  kill: '/System/Library/Sounds/Glass.aiff',
  death: '/System/Library/Sounds/Basso.aiff',
  pickup: '/System/Library/Sounds/Purr.aiff',
  banner: '/System/Library/Sounds/Ping.aiff',
}

const FIRE_THROTTLE_MS = 150
const OTHER_THROTTLE_MS = 250
const BEL = '\x07'

export interface SfxOpts {
  mute: boolean
  platform?: string
  spawner?: (cmd: string, args: string[]) => void
  now?: () => number
  writer?: (s: string) => void
}

/** macOS system-sound effects, zero dependencies (spawns `afplay`). No-op elsewhere except a BEL for kill/death. */
export class Sfx {
  private mute: boolean
  private platform: string
  private spawner: (cmd: string, args: string[]) => void
  private now: () => number
  private writer: (s: string) => void
  private lastPlayed = new Map<SfxEvent, number>()

  constructor(opts: SfxOpts) {
    this.mute = opts.mute
    this.platform = opts.platform ?? process.platform
    this.now = opts.now ?? Date.now
    this.writer = opts.writer ?? ((s) => { process.stdout.write(s) })
    this.spawner = opts.spawner ?? ((cmd, args) => {
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
    })
  }

  play(event: SfxEvent): void {
    if (this.mute) return
    const t = this.now()
    const last = this.lastPlayed.get(event)
    const threshold = event === 'fire' ? FIRE_THROTTLE_MS : OTHER_THROTTLE_MS
    if (last !== undefined && t - last < threshold) return
    this.lastPlayed.set(event, t)

    if (this.platform === 'darwin') {
      this.spawner('afplay', [SOUND_FILES[event]])
      return
    }
    if (event === 'kill' || event === 'death') this.writer(BEL)
  }
}
