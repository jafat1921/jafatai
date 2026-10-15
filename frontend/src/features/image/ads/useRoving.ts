import { useRef } from 'react'

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * Arrow keys for a row/grid of role="radio" buttons: they move focus and pick, like native radios.
 * Returns the tab stop and the keydown handler.
 */
export function useRoving<T>(items: readonly T[], value: T | null | undefined, onChange: (v: T) => void) {
  const box = useRef<HTMLDivElement>(null)
  const at = items.findIndex((x) => x === value)
  const tabStop = at < 0 ? 0 : at
  const onKeyDown = (i: number, e: React.KeyboardEvent) => {
    let to: number | null = null
    if (e.key in NEXT) to = (i + NEXT[e.key] + items.length) % items.length
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = items.length - 1
    if (to === null) return
    e.preventDefault()
    onChange(items[to])
    box.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus()
  }
  return { box, tabStop, onKeyDown }
}
