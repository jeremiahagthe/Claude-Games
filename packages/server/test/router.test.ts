import { describe, expect, it } from 'vitest'
import { route } from '../src/router.js'

describe('route', () => {
  it('maps the three endpoints', () => {
    expect(route('/api/join', 'POST')).toEqual({ kind: 'join' })
    expect(route('/match/abc123def/ws', 'GET')).toEqual({ kind: 'ws', matchId: 'abc123def' })
    expect(route('/', 'GET')).toEqual({ kind: 'health' })
  })
  it('rejects everything else', () => {
    expect(route('/api/join', 'GET')).toBeNull()
    expect(route('/match//ws', 'GET')).toBeNull()
    expect(route('/match/UPPER/ws', 'GET')).toBeNull() // DO ids are lowercase hex
    expect(route('/secret', 'GET')).toBeNull()
  })
})
