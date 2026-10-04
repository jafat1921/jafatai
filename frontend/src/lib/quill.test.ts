import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyQuill, readQuillPref, setQuillPref } from './quill'

function stubPointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : false }))
}

describe('quill cursor preference', () => {
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults to on and toggles the html attribute', () => {
    stubPointer(false)
    expect(readQuillPref()).toBe(true)
    applyQuill(readQuillPref())
    expect(document.documentElement.dataset.quill).toBe('on')

    setQuillPref(false)
    expect(readQuillPref()).toBe(false)
    expect(document.documentElement.dataset.quill).toBe('off')

    setQuillPref(true)
    expect(document.documentElement.dataset.quill).toBe('on')
  })

  it('stays off on touch devices even when the preference is on', () => {
    stubPointer(true)
    setQuillPref(true)
    expect(readQuillPref()).toBe(true)
    expect(document.documentElement.dataset.quill).toBe('off')
  })

  it('survives localStorage throwing', () => {
    stubPointer(false)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readQuillPref()).toBe(true)
    expect(() => setQuillPref(false)).not.toThrow()
    expect(document.documentElement.dataset.quill).toBe('off')
  })
})
