import { describe, expect, it } from 'vitest'
import { boxFrom, clickSelect, EMPTY_SELECTION, intersects, marqueeSelect } from './selection'

const order = ['a', 'b', 'c', 'd', 'e']

describe('multi-select', () => {
  it('toggles one, then Shift adds the range from the anchor in grid order', () => {
    let s = clickSelect(EMPTY_SELECTION, order, 'b')
    expect(s).toEqual({ ids: ['b'], anchor: 'b' })
    s = clickSelect(s, order, 'd', { shiftKey: true })
    expect(s.ids).toEqual(['b', 'c', 'd'])
    // backwards from the same anchor, keeping what's there
    s = clickSelect(s, order, 'a', { shiftKey: true })
    expect([...s.ids].sort()).toEqual(['a', 'b', 'c', 'd'])
    // Ctrl/Cmd (or a plain click while selecting) flips one and moves the anchor
    s = clickSelect(s, order, 'c', { ctrlKey: true })
    expect(s).toEqual({ ids: ['b', 'd', 'a'], anchor: 'c' })
  })

  it('Shift with no anchor, or an anchor no longer loaded, is a plain toggle', () => {
    expect(clickSelect(EMPTY_SELECTION, order, 'c', { shiftKey: true })).toEqual({ ids: ['c'], anchor: 'c' })
    expect(clickSelect({ ids: ['x'], anchor: 'x' }, order, 'c', { shiftKey: true }).ids).toEqual(['x', 'c'])
  })

  it('a marquee replaces the selection, or adds to it with a modifier', () => {
    const s = { ids: ['a'], anchor: 'a' }
    expect(marqueeSelect(s, ['c', 'd'], false)).toEqual({ ids: ['c', 'd'], anchor: 'c' })
    expect(marqueeSelect(s, ['a', 'e'], true).ids).toEqual(['a', 'e'])
  })

  it('boxes intersect only when they overlap', () => {
    const box = boxFrom(100, 100, 10, 10)
    expect(box).toEqual({ left: 10, top: 10, right: 100, bottom: 100 })
    expect(intersects(box, { left: 90, top: 90, right: 200, bottom: 200 })).toBe(true)
    expect(intersects(box, { left: 100, top: 0, right: 200, bottom: 50 })).toBe(false)
  })
})
