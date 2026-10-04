import { describe, expect, it } from 'vitest'
import { wordDiff } from './diff'

describe('wordDiff', () => {
  it('reproduces both texts from its parts', () => {
    const a = 'The keeper polishes the lens.\n\nKEEPER\nForty years.'
    const b = 'The old keeper polishes the brass lens.\n\nKEEPER\nForty long years.'
    const parts = wordDiff(a, b)
    expect(parts.filter((p) => p.type !== 'del').map((p) => p.text).join('')).toBe(b)
    expect(parts.filter((p) => p.type === 'add').map((p) => p.text.trim())).toEqual(['old', 'brass', 'long'])
  })

  it('handles empty before text as one big insert', () => {
    expect(wordDiff('', 'New scene')).toEqual([{ type: 'add', text: 'New scene' }])
  })
})
