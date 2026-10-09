import { describe, expect, it } from 'vitest'
import parity from '@/test/develop-parity.json'
import { developPixel, prepare, upgradeParams, type RGB } from './maths'
import type { DevelopParams } from './types'

// Real server renders (backend tests/test_develop_parity.py): the live preview's maths has to match them.
// Two 8-bit steps of slack covers the server's lookup tables against our exact curves.
const TOL = 2.5 / 255

describe('preview maths match the server engine', () => {
  for (const [name, c] of Object.entries(parity.cases)) {
    it(name, () => {
      const p = upgradeParams(c.params as DevelopParams)
      const pp = prepare(p)
      let worst = 0
      parity.src.forEach((px, i) => {
        const x = i % parity.w
        const y = Math.floor(i / parity.w)
        const got = developPixel(px as RGB, pp, 0, 0, 0, {
          u: (x + 0.5) / parity.w, v: (y + 0.5) / parity.h, aspect: parity.w / parity.h, frameLong: Math.max(parity.w, parity.h),
        })
        const want = c.out[i]
        worst = Math.max(worst, ...got.map((g, k) => Math.abs(g - want[k])))
      })
      expect(worst).toBeLessThan(TOL)
    })
  }
})
