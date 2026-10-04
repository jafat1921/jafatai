import { useEffect, useRef } from 'react'
import { isTypingTarget } from '@/lib/keyboard'
import { isInsideDialog } from './useReviewShortcuts'

export type ShortcutMap = Partial<Record<string, () => void>>

// Space belongs to whatever button has focus, except our own take thumbnails.
function spaceIsTaken(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('[data-space-play]')) return false
  return !!target.closest('button,a[href],summary,[role="button"],[role="checkbox"],[role="switch"],[role="tab"],[role="radio"],video')
}

/**
 * Single-key navigation for the Storyboard / Render canvases (J/K, [ ], L, 1–9, Space).
 * Keys are matched on `event.key` lower-cased; never fires while typing or inside a modal.
 */
export function useStageShortcuts(map: ShortcutMap, enabled = true) {
  const ref = useRef(map)
  useEffect(() => {
    ref.current = map
  })

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target) || isInsideDialog(e.target)) return
      const key = e.key.toLowerCase()
      if (key === ' ' && spaceIsTaken(e.target)) return
      const fn = ref.current[key]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
