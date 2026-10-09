import { useCallback, useState } from 'react'
import { setValue } from '@/lib/photo/params'
import type { DevelopParams } from '@/lib/photo/types'
import { initUndo, push, redo, undo } from '@/lib/photo/undo'

/** Develop params with in-session undo / redo. Every change goes through here. */
export function useDevelop(initial: DevelopParams) {
  const [state, setState] = useState(() => initUndo(initial))

  const replace = useCallback((next: DevelopParams, group: string | null = null) => setState((s) => push(s, next, group)), [])
  const update = useCallback(
    (fn: (p: DevelopParams) => DevelopParams, group: string | null = null) => setState((s) => push(s, fn(s.present), group)),
    [],
  )
  const set = useCallback((key: string, value: number, group: string | null = null) => update((p) => setValue(p, key, value), group), [update])

  return {
    params: state.present,
    set,
    replace,
    update,
    undo: useCallback(() => setState(undo), []),
    redo: useCallback(() => setState(redo), []),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  }
}

export type Develop = ReturnType<typeof useDevelop>
