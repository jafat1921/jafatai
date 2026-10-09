import { describe, expect, it } from 'vitest'
import { enc, wbGains } from './maths'
import { neutralWb } from './wb'

describe('white balance picker', () => {
  it('finds the temperature and tint that cancel a colour cast', () => {
    const cast = wbGains(30, -20)
    const shown = cast.map((k) => Math.round(enc(0.2 * k) * 255)) as [number, number, number]
    const wb = neutralWb(shown)!
    const out = cast.map((k, i) => 0.2 * k * wbGains(wb.temperature, wb.tint)[i])
    expect(Math.max(...out) / Math.min(...out)).toBeLessThan(1.03)
    expect(wb.temperature).toBeLessThan(0)
  })

  it('keeps the current setting in mind and ignores clipped pixels', () => {
    expect(neutralWb([128, 128, 128], 0, 0)).toEqual({ temperature: 0, tint: 0 })
    expect(neutralWb([255, 200, 180])).toBeNull()
    const again = neutralWb([128, 128, 128], 40, 10)!
    expect(again.temperature).toBe(40)
    expect(again.tint).toBe(10)
  })
})
