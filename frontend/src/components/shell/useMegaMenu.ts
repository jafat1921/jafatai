import { useCallback, useEffect, useRef, useState } from 'react'

// navigation.md rev 2: a short intent delay before opening, a longer grace period before closing
export const OPEN_DELAY = 120
export const CLOSE_DELAY = 300

export interface OpenMenu<T extends string> {
  id: T
  // opened from the keyboard: focus moves into the panel and is kept there
  keyboard: boolean
}

export function useMegaMenu<T extends string>(root: React.RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState<OpenMenu<T> | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  const clear = useCallback(() => window.clearTimeout(timer.current), [])
  const later = useCallback(
    (fn: () => void, ms: number) => {
      clear()
      timer.current = window.setTimeout(fn, ms)
    },
    [clear],
  )

  const hoverEnter = useCallback(
    (id: T) => {
      const cur = openRef.current
      if (cur?.id === id) return clear()
      // already browsing the menus: switch without the intent delay
      if (cur) {
        clear()
        return setOpen({ id, keyboard: false })
      }
      later(() => setOpen({ id, keyboard: false }), OPEN_DELAY)
    },
    [clear, later],
  )
  const hoverLeave = useCallback(() => later(() => setOpen(null), CLOSE_DELAY), [later])
  const show = useCallback(
    (id: T, keyboard: boolean) => {
      clear()
      setOpen({ id, keyboard })
    },
    [clear],
  )
  const toggle = useCallback(
    (id: T, keyboard: boolean) => {
      clear()
      setOpen((o) => (o?.id === id ? null : { id, keyboard }))
    },
    [clear],
  )
  const close = useCallback(() => {
    clear()
    setOpen(null)
  }, [clear])

  // outside click (pointerdown so a drag that starts outside also closes it)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, root, close])

  useEffect(() => clear, [clear])

  return { open, hoverEnter, hoverLeave, cancelClose: clear, show, toggle, close }
}
