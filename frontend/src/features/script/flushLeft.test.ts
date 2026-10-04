import { describe, expect, it } from 'vitest'
import { flushLeft } from './flushLeft'

describe('flushLeft', () => {
  it('removes screenplay indentation but keeps blank lines', () => {
    const pasted = 'MARA drifts.\n\n                    NARRATOR (V.O.)\n          Ten years ago.\n'
    expect(flushLeft(pasted)).toBe('MARA drifts.\n\nNARRATOR (V.O.)\nTen years ago.\n')
  })

  it('handles tabs, nbsp and windows line endings', () => {
    expect(flushLeft('\tA\r\n  B  \r\nC')).toBe('A\nB\nC')
  })

  it('leaves already flush text alone', () => {
    const t = 'INT. CABIN - NIGHT\n\nShe waits.'
    expect(flushLeft(t)).toBe(t)
  })
})
