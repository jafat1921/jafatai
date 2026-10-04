import { useEffect } from 'react'

// F6 / Shift+F6 moves focus between [data-f6-region] landmarks in DOM order.
export function useF6Cycle() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F6') return
      const regions = Array.from(document.querySelectorAll<HTMLElement>('[data-f6-region]')).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (!regions.length) return
      e.preventDefault()
      const current = regions.findIndex((r) => r.contains(document.activeElement))
      const step = e.shiftKey ? -1 : 1
      const idx = current === -1 ? (step > 0 ? 0 : regions.length - 1) : (current + step + regions.length) % regions.length
      const next = regions[idx]
      next.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
