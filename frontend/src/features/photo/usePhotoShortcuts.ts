import { useEffect, useRef } from 'react'
import { isTypingTarget } from '@/lib/keyboard'

export interface PhotoKeys {
  save: () => void
  undo: () => void
  redo: () => void
  toggleBefore: () => void
  toggleLoupe: () => void
  toggleCrop: () => void
  escape: () => void
}

/**
 * Ctrl+S save, Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo, \ before/after, L 1:1, C crop,
 * Esc leaves crop or point placing. Inside a text field only Ctrl+S is ours.
 */
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
      if (mod && key === 's') {
        e.preventDefault()
        k.save()
        return
      }
      // a dialog (save look, compare…) or a menu has the keyboard; the tablet slide-over panel doesn't
      const inDialog = e.target instanceof Element && !!e.target.closest('[role="dialog"]:not([data-photo-panel]), [role="alertdialog"], [role="menu"]')
      if (typing || inDialog) return
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) k.redo()
        else k.undo()
      } else if (mod && key === 'y') {
        e.preventDefault()
        k.redo()
      } else if (mod || e.altKey) {
        return
      } else if (e.key === '\\') {
        e.preventDefault()
        k.toggleBefore()
      } else if (key === 'l') {
        k.toggleLoupe()
      } else if (key === 'c') {
        k.toggleCrop()
      } else if (e.key === 'Escape') {
        k.escape()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
