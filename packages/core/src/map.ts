import { MAX_PLAYERS } from './constants.js'
import type { Vec2 } from './types.js'

export interface GameMap {
  id: string
  name: string
  width: number
  height: number
  walls: boolean[]
  spawns: Vec2[]
  railSpawn: Vec2
}

export function isWall(map: GameMap, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return true
  return map.walls[cy * map.width + cx] ?? true
}

export function parseMap(id: string, name: string, text: string): GameMap {
  const rows = text.split('\n').map((r) => r.trimEnd()).filter((r) => r.length > 0)
  const height = rows.length
  const width = Math.max(...rows.map((r) => r.length))
  const walls = new Array<boolean>(width * height).fill(false)
  const spawns: Vec2[] = []
  let railSpawn: Vec2 | null = null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y]![x] ?? '#' // short rows are wall-padded
      if (ch === '#') walls[y * width + x] = true
      else if (ch === 'S') spawns.push({ x: x + 0.5, y: y + 0.5 })
      else if (ch === 'R') railSpawn = { x: x + 0.5, y: y + 0.5 }
    }
  }
  if (spawns.length < MAX_PLAYERS) throw new Error(`${id}: needs >= ${MAX_PLAYERS} spawns, got ${spawns.length}`)
  if (!railSpawn) throw new Error(`${id}: missing R rail-pickup cell`)
  return { id, name, width, height, walls, spawns, railSpawn }
}
