// Synthetic load: N ws clients sending batched random inputs for M seconds.
// Usage: npx tsx scripts/soak.ts http://127.0.0.1:8787 8 60
import WebSocket from 'ws'

const [server = 'http://127.0.0.1:8787', nStr = '8', secsStr = '60'] = process.argv.slice(2)
const n = Number(nStr)
const secs = Number(secsStr)
let snaps = 0
let msgs = 0

async function client(i: number): Promise<void> {
  const res = await fetch(`${server}/api/join`, { method: 'POST', body: '{}' })
  const { matchId } = (await res.json()) as { matchId: string }
  const ws = new WebSocket(`${server.replace(/^http/, 'ws')}/match/${matchId}/ws`)
  await new Promise<void>((r) => ws.on('open', () => r()))
  ws.send(JSON.stringify({ t: 'join', handle: `soak${i}` }))
  ws.on('message', () => { snaps++ })
  let seq = 0
  // Protocol-valid against the current parseClientMsg: seq is an integer >= 0,
  // forward/turn are analog axes in [-1, 1], fire is boolean, aimOffset omitted.
  const timer = setInterval(() => {
    const mk = () => ({
      seq: ++seq,
      forward: (Math.floor(Math.random() * 3) - 1) as -1 | 0 | 1,
      strafe: 0 as const,
      turn: (Math.floor(Math.random() * 3) - 1) as -1 | 0 | 1,
      fire: Math.random() < 0.2,
    })
    ws.send(JSON.stringify({ t: 'input', inputs: [mk(), mk()] }))
    msgs++
  }, 100)
  setTimeout(() => { clearInterval(timer); ws.close() }, secs * 1000)
}

await Promise.all(Array.from({ length: n }, (_, i) => client(i)))
await new Promise((r) => setTimeout(r, secs * 1000 + 2000))
console.log(`clients=${n} duration=${secs}s`)
console.log(`snapshots received: ${snaps} (${(snaps / n / secs).toFixed(1)}/s per client — expect ~20)`)
console.log(`input packets sent: ${msgs} (${(msgs / n / secs).toFixed(1)}/s per client — expect ~10)`)
console.log(`billable-request estimate/match-minute: ${Math.round((msgs / secs) * 60 / 20)} (incoming ws msgs / 20)`)
