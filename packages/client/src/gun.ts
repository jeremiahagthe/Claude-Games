import type { FrameBuffer } from './framebuffer.js'

// First-person gun overlay: cheap pixel-art rectangles, drawn last (over
// everything, no zbuf) so it always reads on top of the 3D view.
const BARREL_BLASTER: readonly [number, number, number] = [90, 100, 125]
const BARREL_RAIL_ACCENT: readonly [number, number, number] = [80, 220, 255]
const GRIP: readonly [number, number, number] = [45, 42, 50]
const HIGHLIGHT: readonly [number, number, number] = [150, 160, 185]
const BARREL_W = 4

export function drawGun(fb: FrameBuffer, weapon: 'blaster' | 'rail', recoil: number): void {
  const r = Math.max(0, Math.min(1, recoil))
  const shift = Math.round(r * fb.h * 0.06) // down-right kick, up to 6% of height

  const gunH = Math.max(4, Math.round(fb.h * 0.22)) // ~22% of screen height
  const gunW = Math.max(6, Math.round(fb.w * 0.16))
  const anchorX = Math.round(fb.w * 0.64) + shift // bottom-center-right, classic Doom offset
  const bottom = fb.h - 1 + shift
  const top = bottom - gunH

  // grip: darker block anchoring the barrel to the bottom of the frame
  const gripW = Math.max(3, Math.round(gunW * 0.7))
  const gripH = Math.max(2, Math.round(gunH * 0.45))
  const gripX0 = anchorX - (gripW >> 1)
  const gripY0 = bottom - gripH
  for (let y = gripY0; y <= bottom; y++) {
    for (let x = gripX0; x < gripX0 + gripW; x++) fb.set(x, y, GRIP[0], GRIP[1], GRIP[2])
  }

  // barrel: a 3-4px-wide slightly diagonal column rising from the grip
  const base = weapon === 'rail' ? BARREL_RAIL_ACCENT : BARREL_BLASTER
  const tipBrighten = Math.min(255, r * 120)
  for (let row = 0; row < gunH; row++) {
    const y = top + row
    if (y < 0 || y >= fb.h) continue
    const t = row / Math.max(1, gunH - 1) // 0 at the tip (top), 1 at the grip (bottom)
    const drift = Math.round((1 - t) * 2) // slight diagonal lean toward the tip
    const xCenter = anchorX + drift
    const isTip = row < 2
    const isTopHighlightBand = row < gunH * 0.15
    for (let dx = 0; dx < BARREL_W; dx++) {
      const x = xCenter - (BARREL_W >> 1) + dx
      const edge = dx === 0 || dx === BARREL_W - 1
      let [cr, cg, cb] = base
      if (weapon === 'rail' && dx === BARREL_W - 1) [cr, cg, cb] = BARREL_RAIL_ACCENT
      if (edge && isTopHighlightBand) [cr, cg, cb] = HIGHLIGHT
      if (isTip) {
        cr = Math.min(255, cr + tipBrighten)
        cg = Math.min(255, cg + tipBrighten)
        cb = Math.min(255, cb + tipBrighten)
      }
      fb.set(x, y, cr, cg, cb)
    }
  }
}
