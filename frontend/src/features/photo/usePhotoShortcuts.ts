import { useEffect, useRef } from 'react'
import { isTypingTarget } from '@/lib/keyboard'

export interface PhotoKeys {
  save: () => void
  undo: () => void
  redo: () => void
  toggleBefore: () => void
  toggleZoom: () => void
  toggleCrop: () => void
  escape: () => void
  compare: (mode: 'lr' | 'lr-split' | 'tb') => void
  lights: () => void
  info: () => void
  clip: () => void
  panels: (all: boolean) => void
  fullscreen: () => void
  grid: () => void
  copy: () => void
  paste: () => void
  previous: () => void
  sync: () => void
  reset: () => void
  snapshot: () => void
  panel: (n: number) => void
  // V: colour / black & white; W: white balance picker
  treatment?: () => void
  whiteBalance?: () => void
}

// Lightroom's own Ctrl+Shift+C / Ctrl+Shift+R / Ctrl+N belong to the browser (inspector, hard reload,
// new window), so the settings shortcuts live on Ctrl+Alt instead
export const SHORTCUTS: [string, string][] = [
  ['Ctrl+S', 'Save as new version'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['\\', 'Before only'],
  ['Y · Shift+Y · Alt+Y', 'Before|After · split · top/bottom'], ['Z', 'Fit / 100%'], ['R or C', 'Crop'],
  ['J', 'Show clipping'], ['I', 'Info overlay'], ['L', 'Lights dim / off'], ['Tab · Shift+Tab', 'Hide side panels · all'],
  ['F', 'Full screen'], ['Ctrl+Alt+O', 'Grid overlay'], [', .', 'Previous / next slider'], ['+ −', 'Nudge the slider'],
  ['Ctrl+1…9', 'Open a panel'], ['V', 'Black & white'], ['W', 'White balance picker'], ['Ctrl+Alt+C / V', 'Copy / paste settings'], ['Ctrl+Alt+P', 'Previous photo’s settings'],
  ['Ctrl+Alt+S', 'Sync to selected'], ['Ctrl+Alt+R', 'Reset'], ['Ctrl+Alt+N', 'New snapshot'], ['Ctrl+← →', 'Previous / next photo'], ['G', 'Back to Library'],
]

/** Move keyboard focus to the previous / next develop slider (Lightroom's , and .). */
function stepSlider(dir: 1 | -1) {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>('[data-develop-slider] input[type="range"]')).filter((el) => el.offsetParent !== null)
  if (!all.length) return
  const at = all.findIndex((el) => el === document.activeElement)
  const next = all[at < 0 ? (dir > 0 ? 0 : all.length - 1) : (at + dir + all.length) % all.length]
  next.focus()
  next.scrollIntoView?.({ block: 'nearest' })
}

/** Develop's keyboard. Inside a text field only Ctrl+S is ours; a slider keeps its arrows and + −. */
export function usePhotoShortcuts(keys: PhotoKeys) {
  const latest = useRef(keys)
  useEffect(() => {
    latest.current = keys
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = latest.current
      const mod = e.ctrlKey || e.metaKey
      const typing = isTypingTarget(e.target)
      const key = e.key.toLowerCase()
      if (mod && key === 's' && !e.altKey) {
        e.preventDefault()
        k.save()
        return
      }
      // a dialog (save look, compare…) or a menu has the keyboard; the tablet slide-over panel doesn't
      const inDialog = e.target instanceof Element && !!e.target.closest('[role="dialog"]:not([data-photo-panel]), [role="alertdialog"], [role="menu"]')
      if (typing || inDialog) return
      const act = (fn: () => void) => {
        e.preventDefault()
        fn()
      }
      if (mod && e.altKey) {
        const map: Record<string, () => void> = { c: k.copy, v: k.paste, p: k.previous, s: k.sync, r: k.reset, n: k.snapshot, o: k.grid }
        // e.code: Alt changes e.key on some layouts
        const letter = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : key
        if (map[letter]) act(map[letter])
        return
      }
      if (mod && key === 'z') return act(e.shiftKey ? k.redo : k.undo)
      if (mod && key === 'y') return act(k.redo)
      if (mod && /^digit[1-9]$/i.test(e.code)) return act(() => k.panel(Number(e.code.slice(5))))
      if (mod) return
      if (e.key === 'Tab') return act(() => k.panels(e.shiftKey))
      if (e.altKey && key === 'y') return act(() => k.compare('tb'))
      if (e.altKey) return
      const onSlider = e.target instanceof HTMLInputElement && e.target.type === 'range'
      if (e.key === ',' || e.key === '.') return act(() => stepSlider(e.key === '.' ? 1 : -1))
      if (onSlider && ['+', '-', '=', '_'].includes(e.key)) return
      if (e.key === '\\') return act(k.toggleBefore)
      if (key === 'y') return act(() => k.compare(e.shiftKey ? 'lr-split' : 'lr'))
      if (key === 'z') return act(k.toggleZoom)
      if (key === 'c' || key === 'r') return act(k.toggleCrop)
      if (key === 'l') return act(k.lights)
      if (key === 'i') return act(k.info)
      if (key === 'j') return act(k.clip)
      if (key === 'f') return act(k.fullscreen)
      if (key === 'v' && k.treatment) return act(k.treatment)
      if (key === 'w' && k.whiteBalance) return act(k.whiteBalance)
      if (e.key === 'Escape') k.escape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
