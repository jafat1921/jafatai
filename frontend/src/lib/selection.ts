/** Multi-select rules for media grids (P4): plain toggle, Shift range from the anchor, marquee boxes. */

export interface Selection {
  ids: string[]
  // where the next Shift-click range starts
  anchor: string | null
}

export const EMPTY_SELECTION: Selection = { ids: [], anchor: null }

export interface Mods {
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

export function toggle(sel: Selection, id: string): Selection {
  const on = !sel.ids.includes(id)
  return { ids: on ? [...sel.ids, id] : sel.ids.filter((x) => x !== id), anchor: id }
}

/** Shift adds the range anchor…id (in grid order) to what is already picked; anything else toggles one. */
export function clickSelect(sel: Selection, order: string[], id: string, mods: Mods = {}): Selection {
  if (mods.shiftKey && sel.anchor && sel.anchor !== id) {
    const a = order.indexOf(sel.anchor)
    const b = order.indexOf(id)
    if (a !== -1 && b !== -1) {
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
      const ids = [...sel.ids, ...range.filter((x) => !sel.ids.includes(x))]
      return { ids, anchor: sel.anchor }
    }
  }
  return toggle(sel, id)
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export const boxFrom = (x1: number, y1: number, x2: number, y2: number): Box => ({
  left: Math.min(x1, x2),
  top: Math.min(y1, y2),
  right: Math.max(x1, x2),
  bottom: Math.max(y1, y2),
})

export const intersects = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/** A marquee replaces the selection, or adds to it with Shift / Ctrl / Cmd held. */
export function marqueeSelect(sel: Selection, hits: string[], additive: boolean): Selection {
  if (!additive) return { ids: hits, anchor: hits[0] ?? sel.anchor }
  return { ids: [...sel.ids, ...hits.filter((h) => !sel.ids.includes(h))], anchor: sel.anchor ?? hits[0] ?? null }
}

// drag payload between tiles and folders
export const DRAG_MIME = 'application/x-mixai-refs'
