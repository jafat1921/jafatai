import { useEffect, useRef } from 'react'
import { isTypingTarget } from '@/lib/keyboard'

export interface ReviewShortcutHandlers {
  approve?: () => void
  regenerate?: () => void
  regenerateWithNote?: () => void
  editAndRegenerate?: () => void
  reject?: () => void
  toggleVersions?: () => void
}

// the Inspector slide-over is a dialog too, but review shortcuts should keep working inside it
function isInsideDialog(target: EventTarget | null) {
  return target instanceof HTMLElement && !!target.closest('[role="dialog"]:not([data-review-scope]),[role="alertdialog"],[role="menu"]')
}

// A / R / Shift+R / E / X / V from design-system §4. Undefined handler = action not available now.
export function useReviewShortcuts(handlers: ReviewShortcutHandlers, enabled = true) {
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target) || isInsideDialog(e.target)) return
      const h = ref.current
      const key = e.key.toLowerCase()
      let fn: (() => void) | undefined
      if (key === 'a') fn = h.approve
      else if (key === 'r') fn = e.shiftKey ? h.regenerateWithNote : h.regenerate
      else if (key === 'e' && !e.shiftKey) fn = h.editAndRegenerate
      else if (key === 'x' && !e.shiftKey) fn = h.reject
      else if (key === 'v' && !e.shiftKey) fn = h.toggleVersions
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
