import { useSyncExternalStore } from 'react'

const KEY = 'mixai.quillCursor'
const listeners = new Set<() => void>()

const isCoarse = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

export function readQuillPref(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

// Touch devices never get the quill — there is no pointer to draw.
export function applyQuill(on: boolean) {
  document.documentElement.dataset.quill = on && !isCoarse() ? 'on' : 'off'
}

export function setQuillPref(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* preference just won't persist */
  }
  applyQuill(on)
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useQuillCursor() {
  const on = useSyncExternalStore(subscribe, readQuillPref, () => true)
  return [on, setQuillPref] as const
}
