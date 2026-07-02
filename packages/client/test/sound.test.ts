import { describe, expect, it } from 'vitest'
import { Sfx } from '../src/sound.js'

function mkClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('Sfx on darwin', () => {
  it('spawns afplay with the correct sound file per event', () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const clock = mkClock()
    const sfx = new Sfx({ mute: false, platform: 'darwin', spawner: (cmd, args) => calls.push({ cmd, args }), now: clock.now })
    sfx.play('fire')
    sfx.play('kill') // different event: not throttled against 'fire'
    expect(calls).toHaveLength(2)
    expect(calls[0]!.cmd).toBe('afplay')
    expect(calls[0]!.args).toEqual(['/System/Library/Sounds/Tink.aiff'])
    expect(calls[1]!.args).toEqual(['/System/Library/Sounds/Glass.aiff'])
  })

  it('maps every event to its sound file', () => {
    const calls: string[][] = []
    const clock = mkClock()
    const sfx = new Sfx({ mute: false, platform: 'darwin', spawner: (_cmd, args) => calls.push(args), now: clock.now })
    sfx.play('death')
    clock.advance(300)
    sfx.play('pickup')
    clock.advance(300)
    sfx.play('banner')
    expect(calls[0]).toEqual(['/System/Library/Sounds/Basso.aiff'])
    expect(calls[1]).toEqual(['/System/Library/Sounds/Purr.aiff'])
    expect(calls[2]).toEqual(['/System/Library/Sounds/Ping.aiff'])
  })

  it('throttles fire events to >=150ms apart, dropping rapid repeats', () => {
    const calls: string[][] = []
    const clock = mkClock()
    const sfx = new Sfx({ mute: false, platform: 'darwin', spawner: (_cmd, args) => calls.push(args), now: clock.now })
    sfx.play('fire') // t=0: allowed
    clock.advance(100) // t=100
    sfx.play('fire') // 100ms since last play, <150ms: dropped
    clock.advance(40) // t=140
    sfx.play('fire') // 140ms since last play, <150ms: dropped
    clock.advance(20) // t=160
    sfx.play('fire') // 160ms since last play, >=150ms: allowed
    expect(calls).toHaveLength(2)
  })

  it('throttles non-fire events to >=250ms apart, dropping rapid repeats', () => {
    const calls: string[][] = []
    const clock = mkClock()
    const sfx = new Sfx({ mute: false, platform: 'darwin', spawner: (_cmd, args) => calls.push(args), now: clock.now })
    sfx.play('kill')
    clock.advance(200) // under 250ms: dropped
    sfx.play('kill')
    clock.advance(60) // now 260ms since the first play: allowed
    sfx.play('kill')
    expect(calls).toHaveLength(2)
  })

  it('does not throttle across different event types', () => {
    const calls: string[][] = []
    const clock = mkClock()
    const sfx = new Sfx({ mute: false, platform: 'darwin', spawner: (_cmd, args) => calls.push(args), now: clock.now })
    sfx.play('fire')
    sfx.play('kill')
    sfx.play('death')
    sfx.play('pickup')
    sfx.play('banner')
    expect(calls).toHaveLength(5)
  })

  it('mute is a no-op: no spawner calls at all', () => {
    const calls: string[][] = []
    const sfx = new Sfx({ mute: true, platform: 'darwin', spawner: (_cmd, args) => calls.push(args) })
    sfx.play('fire')
    sfx.play('kill')
    expect(calls).toHaveLength(0)
  })
})

describe('Sfx on non-darwin', () => {
  it('never calls the spawner (no afplay)', () => {
    const calls: string[][] = []
    const written: string[] = []
    const sfx = new Sfx({
      mute: false,
      platform: 'linux',
      spawner: (_cmd, args) => calls.push(args),
      writer: (s) => written.push(s),
    })
    sfx.play('fire')
    sfx.play('kill')
    expect(calls).toHaveLength(0)
  })

  it('writes BEL for kill and death only, via an injected writer', () => {
    const written: string[] = []
    const clock = mkClock()
    const sfx = new Sfx({
      mute: false,
      platform: 'linux',
      spawner: () => { throw new Error('should never spawn on non-darwin') },
      now: clock.now,
      writer: (s: string) => written.push(s),
    })
    sfx.play('fire') // no BEL: not kill/death
    sfx.play('kill')
    clock.advance(300)
    sfx.play('death')
    clock.advance(300)
    sfx.play('pickup') // no BEL
    sfx.play('banner') // no BEL
    expect(written).toEqual(['\x07', '\x07'])
  })

  it('mute suppresses BEL writes too', () => {
    const written: string[] = []
    const sfx = new Sfx({
      mute: true,
      platform: 'linux',
      spawner: () => { throw new Error('should never spawn') },
      writer: (s: string) => written.push(s),
    })
    sfx.play('kill')
    expect(written).toHaveLength(0)
  })
})
