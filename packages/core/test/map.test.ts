import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS } from '../src/constants.js'
import { isWall, parseMap } from '../src/map.js'
import { MAPS, mapById } from '../src/maps.js'

const TINY = `
#####
#S.R#
#.#.#
#S.S#
#####
`

describe('parseMap', () => {
  it('parses walls, spawns, rail at cell centers', () => {
    // relax MAX_PLAYERS check via a map with enough spawns? No — TINY is for geometry:
    // parseMap enforces spawns >= MAX_PLAYERS, so expect the throw here.
    expect(() => parseMap('tiny', 'Tiny', TINY)).toThrow(/spawns/)
  })
  it('geometry: isWall and centers via a big-enough map', () => {
    const rows = ['##########', '#SSSSSSSS#', '#...R....#', '##########'].join('\n')
    const m = parseMap('t', 'T', rows)
    expect(m.width).toBe(10)
    expect(m.height).toBe(4)
    expect(isWall(m, 0, 0)).toBe(true)
    expect(isWall(m, 1, 1)).toBe(false)
    expect(isWall(m, -1, 2)).toBe(true) // out of bounds = wall
    expect(m.spawns[0]).toEqual({ x: 1.5, y: 1.5 })
    expect(m.railSpawn).toEqual({ x: 4.5, y: 2.5 })
  })
})

describe('built-in maps', () => {
  it('has the three spec maps', () => {
    expect(MAPS.map((m) => m.id).sort()).toEqual(['legacy_monolith', 'microservices', 'node_modules'])
    expect(() => mapById('nope')).toThrow()
  })
  for (const id of ['node_modules', 'legacy_monolith', 'microservices']) {
    it(`${id}: enclosed, ${MAX_PLAYERS}+ spawns, rail reachable from every spawn`, () => {
      const m = mapById(id)
      expect(m.spawns.length).toBeGreaterThanOrEqual(MAX_PLAYERS)
      // border fully walled
      for (let x = 0; x < m.width; x++) {
        expect(isWall(m, x, 0)).toBe(true)
        expect(isWall(m, x, m.height - 1)).toBe(true)
      }
      for (let y = 0; y < m.height; y++) {
        expect(isWall(m, 0, y)).toBe(true)
        expect(isWall(m, m.width - 1, y)).toBe(true)
      }
      // flood fill from first spawn reaches all spawns + rail
      const seen = new Set<string>()
      const queue = [[Math.floor(m.spawns[0]!.x), Math.floor(m.spawns[0]!.y)]]
      while (queue.length) {
        const [cx, cy] = queue.pop()!
        const key = `${cx},${cy}`
        if (seen.has(key) || isWall(m, cx!, cy!)) continue
        seen.add(key)
        queue.push([cx! + 1, cy!], [cx! - 1, cy!], [cx!, cy! + 1], [cx!, cy! - 1])
      }
      for (const s of m.spawns) expect(seen.has(`${Math.floor(s.x)},${Math.floor(s.y)}`)).toBe(true)
      expect(seen.has(`${Math.floor(m.railSpawn.x)},${Math.floor(m.railSpawn.y)}`)).toBe(true)
    })
  }
})
