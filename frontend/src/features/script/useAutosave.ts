import { useCallback, useEffect, useRef, useState } from 'react'

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/**
 * Debounced field-level autosave. Edits accumulate into one patch; a failed save keeps the
 * patch so the next edit (or Retry) resends it. Pending edits are flushed on unmount so
 * switching scenes never drops text.
 */
export function useAutosave<T extends object>(save: (patch: Partial<T>) => Promise<unknown>, delay = 800) {
  const [state, setState] = useState<SaveState>('idle')
  const pending = useRef<Partial<T>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saveRef = useRef(save)
  const inflight = useRef(false)

  useEffect(() => {
    saveRef.current = save
  })

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (inflight.current || Object.keys(pending.current).length === 0) return
    inflight.current = true
    try {
      // loop rather than recurse: the user may keep typing while a save is in flight
      while (Object.keys(pending.current).length) {
        const patch = pending.current
        pending.current = {}
        setState('saving')
        try {
          await saveRef.current(patch)
        } catch {
          pending.current = { ...patch, ...pending.current }
          setState('error')
          return
        }
      }
      setState('saved')
    } finally {
      inflight.current = false
    }
  }, [])

  const change = useCallback(
    (patch: Partial<T>) => {
      pending.current = { ...pending.current, ...patch }
      setState('dirty')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), delay)
    },
    [delay, flush],
  )

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      void flush()
    }
  }, [flush])

  return { state, change, flush }
}
