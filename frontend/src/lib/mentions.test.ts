import { describe, expect, it } from 'vitest'
import { placeholdersIn } from './images'
import { insertMention, mentionRefCount, plainPrompt, queryAt, rememberOptions, relink, serialize, tokensOf, toDisplay, unlink, type MentionOption } from './mentions'

const mara: MentionOption = { type: 'character', id: 'c1', label: 'Mara', ref_generation_id: 'g1' }
const brew: MentionOption = { type: 'product', id: 'p1', label: 'Leaf Cold Brew', ref_generation_id: 'g2' }

describe('mention tokens', () => {
  it('shows @Name, keeps the token in the value, and drops it when the name is deleted', () => {
    const value = 'A boat. @[Mara](character:c1) waves at @[Leaf Cold Brew](product:p1)'
    expect(toDisplay(value)).toBe('A boat. @Mara waves at @Leaf Cold Brew')
    expect(plainPrompt(value)).toBe('A boat. Mara waves at Leaf Cold Brew')
    // typing elsewhere keeps both links
    expect(serialize('A small boat. @Mara waves at @Leaf Cold Brew', tokensOf(value))).toBe(
      'A small boat. @[Mara](character:c1) waves at @[Leaf Cold Brew](product:p1)',
    )
    // the name is gone, so is the token
    expect(tokensOf(serialize('A boat. waves at @Leaf Cold Brew', tokensOf(value)))).toEqual([{ label: 'Leaf Cold Brew', type: 'product', id: 'p1' }])
    // "@Maranta" is another word, not Mara
    expect(serialize('@Maranta', tokensOf(value))).toBe('@Maranta')
  })

  it('inserts a pick in place of the typed query', () => {
    const display = 'Close on @ma'
    const q = queryAt(display, display.length)
    expect(q).toEqual({ start: 9, query: 'ma' })
    const next = insertMention('Close on @ma', q!.start, display.length, mara)
    expect(next.value).toBe('Close on @[Mara](character:c1) ')
    expect(next.caret).toBe('Close on @Mara '.length)
    expect(queryAt('mail me@home', 12)).toBeNull()
    expect(queryAt('line one\n@', 10)).toEqual({ start: 9, query: '' })
  })

  it('works with Urdu text and Urdu names', () => {
    const urdu: MentionOption = { type: 'character', id: 'c2', label: 'مارا', ref_generation_id: null }
    const display = 'ساحل پر @ما'
    const q = queryAt(display, display.length)!
    expect(q.query).toBe('ما')
    const next = insertMention(display, q.start, display.length, urdu)
    expect(next.value).toBe('ساحل پر @[مارا](character:c2) ')
    expect(toDisplay(next.value + 'چل رہی ہے')).toBe('ساحل پر @مارا چل رہی ہے')
    expect(serialize('ساحل پر @مارا تیزی سے', tokensOf(next.value))).toBe('ساحل پر @[مارا](character:c2) تیزی سے')
  })

  it('unlinks, relinks after a rewrite, and counts references', () => {
    const value = '@[Mara](character:c1) holds @[Leaf Cold Brew](product:p1), @[Mara](character:c1) smiles'
    expect(unlink(value, mara)).toBe('Mara holds @[Leaf Cold Brew](product:p1), Mara smiles')
    // the magic prompt answers with plain names
    expect(relink('Golden light. Mara lifts the Leaf Cold Brew can.', tokensOf(value))).toBe(
      'Golden light. @[Mara](character:c1) lifts the @[Leaf Cold Brew](product:p1) can.',
    )
    rememberOptions([mara, brew, { type: 'location', id: 'l1', label: 'Quay', ref_generation_id: null }])
    expect(mentionRefCount(value)).toBe(2)
    expect(mentionRefCount(value + ' at @[Quay](location:l1)')).toBe(2)
  })

  it('tells two things with the same name apart', () => {
    const twin: MentionOption = { type: 'product', id: 'p9', label: 'Mara', hint: 'Leaf' }
    const next = insertMention('@[Mara](character:c1) with @', 11, 12, twin)
    expect(tokensOf(next.value).map((t) => t.label)).toEqual(['Mara', 'Mara Leaf'])
  })

  it('is not mistaken for a [placeholder] slot', () => {
    expect(placeholdersIn('@[Mara](character:c1) holds a [product]')).toEqual(['[product]'])
  })
})
