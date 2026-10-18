import { describe, expect, it } from 'vitest'
import { speechHint } from './video'

describe('speechHint', () => {
  it('warns about quoted lines the video model cannot pronounce', () => {
    expect(speechHint('She smiles and says "سمندر خاموش ہے"')).toMatch(/Urdu or Hindi/)
    expect(speechHint('He whispers “आज समंदर शांत है”')).toMatch(/Character Studio/)
  })

  it('stays quiet for English lines and unquoted script', () => {
    expect(speechHint('She says "We should go home now."')).toBeNull()
    expect(speechHint('A sign reads سمندر in the distance')).toBeNull()
    expect(speechHint('Waves at dawn')).toBeNull()
  })
})
