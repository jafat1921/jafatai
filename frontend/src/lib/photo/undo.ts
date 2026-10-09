// In-session undo for the develop params. A drag sends many changes under one `group` key; those
// fold into a single step so Ctrl+Z undoes the whole drag, not one pixel of it.

export interface UndoState<T> {
  past: T[]
  present: T
  future: T[]
  group: string | null
  at: number
}

const LIMIT = 200
const FOLD_MS = 800

export const initUndo = <T>(present: T): UndoState<T> => ({ past: [], present, future: [], group: null, at: 0 })

export function push<T>(s: UndoState<T>, next: T, group: string | null = null, now = Date.now()): UndoState<T> {
  if (Object.is(next, s.present)) return s
  if (group && group === s.group && now - s.at < FOLD_MS) return { ...s, present: next, future: [], at: now }
  return { past: [...s.past, s.present].slice(-LIMIT), present: next, future: [], group, at: now }
}

export function undo<T>(s: UndoState<T>): UndoState<T> {
  if (!s.past.length) return s
  return { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future], group: null, at: 0 }
}

export function redo<T>(s: UndoState<T>): UndoState<T> {
  if (!s.future.length) return s
  return { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1), group: null, at: 0 }
}
