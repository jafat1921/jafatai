import { describe, expect, it } from 'vitest'
import { aerabNote, aerabTerm, hasArabicScript, isArabicScriptLang, joinLines, splitLines } from './aerab'

describe('aerab helpers', () => {
  it('reports results in plain words', () => {
    expect(aerabNote(12, 0)).toBe('Aerab added to 12 lines.')
    expect(aerabNote(1, 1)).toBe('Aerab added to 1 line. 1 line kept as written: the marking changed their words, so they were left alone.')
    expect(aerabNote(0, 0, 2)).toBe('No lines needed aerab. 2 lines still lightly marked; check them before voicing.')
  })

  it('knows the Arabic-script languages and letters', () => {
    expect(['ur', 'ar', 'fa', 'ps', 'sd', 'pnb', 'ar-EG', 'pa-Arab'].every(isArabicScriptLang)).toBe(true)
    expect(['en', 'hi', 'ur-latn', '', null].some(isArabicScriptLang)).toBe(false)
    expect(hasArabicScript('دل کی بات') && hasArabicScript('هذا سطر') && !hasArabicScript('dil ki baat')).toBe(true)
    // Arabic digits and punctuation alone are not text to mark
    expect(hasArabicScript('١٢٣ ؟')).toBe(false)
    expect(aerabTerm('ar')).toBe('tashkeel')
    expect(aerabTerm('ur')).toBe('aerab')
  })

  it('sends many lines as one body and puts them back', () => {
    const texts = ['دل کی\nبات', 'hello', 'آج']
    expect(joinLines(texts)).toBe('دل کی بات\nhello\nآج')
    // an untouched line keeps its own line break; a marked one comes back marked
    expect(splitLines(texts, 'دل کی بات\nhello\nآجَ')).toEqual(['دل کی\nبات', 'hello', 'آجَ'])
    expect(splitLines(texts, 'one line')).toBeNull()
  })
})
