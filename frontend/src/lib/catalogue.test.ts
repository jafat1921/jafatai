import { describe, expect, it } from 'vitest'
import { EMPTY_FILTER, albumTree, apiQuery, exposureLine, filterCount, keyAction, parseSource, readFilter, sourceKey, step, writeFilter, type Album } from './catalogue'

const k = (key: string, mods: Partial<KeyboardEvent> = {}) => keyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent)

describe('catalogue keys', () => {
  it('speaks Lightroom', () => {
    expect(k('3')).toEqual({ type: 'rate', value: 3 })
    expect(k('0')).toEqual({ type: 'rate', value: 0 })
    expect(k('p')).toEqual({ type: 'flag', value: 'pick' })
    expect(k('X')).toEqual({ type: 'flag', value: 'reject' })
    expect(k('u')).toEqual({ type: 'flag', value: 'none' })
    expect(k('6')).toEqual({ type: 'label', value: 'red' })
    expect(k('9')).toEqual({ type: 'label', value: 'blue' })
    expect(k('g')).toEqual({ type: 'view', value: 'grid' })
    expect(k('e')).toEqual({ type: 'view', value: 'loupe' })
    expect(k('n')).toEqual({ type: 'view', value: 'survey' })
    expect(k('ArrowDown', { shiftKey: true })).toEqual({ type: 'move', dx: 0, dy: 1, extend: true })
    expect(k('a', { ctrlKey: true })).toEqual({ type: 'selectAll' })
    // Ctrl+P / Ctrl+C belong to the browser
    expect(k('p', { ctrlKey: true })).toBeNull()
    expect(k('c', { metaKey: true })).toBeNull()
    expect(k('q')).toBeNull()
  })

  it('steps around a grid without falling off', () => {
    expect(step(0, 10, 4, 1, 0)).toBe(1)
    expect(step(1, 10, 4, 0, 1)).toBe(5)
    expect(step(8, 10, 4, 0, 1)).toBe(9)
    expect(step(0, 10, 4, -1, 0)).toBe(0)
    expect(step(0, 0, 4, 1, 0)).toBe(-1)
  })
})

describe('sources and filters', () => {
  it('round-trips through the URL', () => {
    const f = { ...EMPTY_FILTER, q: 'henna', ratingMin: 3, flags: ['pick', 'none'], labels: ['red'], cameras: ['NIKON Z 8', 'Canon, EOS'], keywords: ['bride'], dateFrom: '2026-05-01', dateTo: '2026-05-31', edited: true }
    const p = writeFilter(new URLSearchParams('src=album:a1&view=loupe'), f)
    expect(readFilter(p)).toEqual(f)
    expect(p.get('src')).toBe('album:a1')
    expect(filterCount(f)).toBe(8)
    expect(readFilter(writeFilter(p, EMPTY_FILTER))).toEqual(EMPTY_FILTER)
  })

  it('turns sources into API queries', () => {
    expect(parseSource('album:a1')).toEqual({ kind: 'album', id: 'a1' })
    expect(parseSource('nonsense')).toEqual({ kind: 'all' })
    expect(sourceKey({ kind: 'client', id: 'c1' })).toBe('client:c1')
    expect(apiQuery({ kind: 'album', id: 'a1' }, { ...EMPTY_FILTER, ratingMin: 4 })).toMatchObject({ album_id: 'a1', rating_min: 4 })
    expect(apiQuery({ kind: 'picks' }, EMPTY_FILTER).flag).toBe('pick')
    expect(apiQuery({ kind: 'recent' }, EMPTY_FILTER).added_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(apiQuery({ kind: 'all' }, { ...EMPTY_FILTER, cameras: ['A', 'B'] }).camera).toBe('A|B')
  })

  it('nests albums under their folders', () => {
    const a = (id: string, parent: string | null, kind: Album['kind'] = 'album') => ({ id, name: id, kind, parent_id: parent }) as Album
    expect(albumTree([a('leaf', 'f2'), a('f1', null, 'folder'), a('f2', 'f1', 'folder'), a('top', null)]).map((x) => [x.album.id, x.depth])).toEqual([
      ['f1', 0], ['f2', 1], ['leaf', 2], ['top', 0],
    ])
  })

  it('writes exposure like a camera back', () => {
    expect(exposureLine({ focal_mm: 85, aperture: 1.8, shutter_s: 1 / 250, iso: 400 })).toBe('85 mm · f/1.8 · 1/250 · ISO 400')
    expect(exposureLine({ shutter_s: 2.5 })).toBe('2.5s')
  })
})
