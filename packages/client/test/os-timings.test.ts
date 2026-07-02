import { describe, expect, it } from 'vitest'
import { FACTORY_TIMINGS, parseKeyTimings, readOsKeyTimings } from '../src/input/os-timings.js'

describe('parseKeyTimings — pure parsing of `defaults read -g` output (never shells out)', () => {
  it('converts defaults ticks to ms (×15)', () => {
    expect(parseKeyTimings('25\n', '2\n')).toEqual({ initialDelayMs: 375, repeatIntervalMs: 30 })
    expect(parseKeyTimings('15', '2')).toEqual({ initialDelayMs: 225, repeatIntervalMs: 30 })
  })

  it('clamps pathological values into [150, 2000] / [15, 400]', () => {
    expect(parseKeyTimings('500\n', '200\n')).toEqual({ initialDelayMs: 2000, repeatIntervalMs: 400 })
    expect(parseKeyTimings('1\n', '1\n')).toEqual({ initialDelayMs: 150, repeatIntervalMs: 15 })
  })

  it('falls back to factory 500/83 on unreadable values', () => {
    expect(parseKeyTimings(null, null)).toEqual(FACTORY_TIMINGS)
    expect(parseKeyTimings('not a number\n', '-3\n')).toEqual(FACTORY_TIMINGS)
    expect(parseKeyTimings('0\n', 'NaN\n')).toEqual(FACTORY_TIMINGS)
  })

  it('falls back per-field: the two defaults keys are independently unset-able', () => {
    expect(parseKeyTimings('25\n', null)).toEqual({ initialDelayMs: 375, repeatIntervalMs: 83 })
    expect(parseKeyTimings(null, '2\n')).toEqual({ initialDelayMs: 500, repeatIntervalMs: 30 })
  })
})

describe('readOsKeyTimings — platform gate', () => {
  it('returns factory timings on non-darwin platforms without shelling out', () => {
    expect(readOsKeyTimings('linux')).toEqual(FACTORY_TIMINGS)
    expect(readOsKeyTimings('win32')).toEqual(FACTORY_TIMINGS)
  })
})
