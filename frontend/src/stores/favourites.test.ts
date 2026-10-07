import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi } from '@/test/media-fixtures'
import { useFavourites } from './favourites'

afterEach(() => vi.unstubAllGlobals())

describe('favourites move to the server', () => {
  it('hands the old browser-only hearts over once, then forgets them locally', async () => {
    localStorage.setItem('mixai.favourites', JSON.stringify(['m1', 'g7']))
    const calls = mockApi((method, path, _q, body) => {
      if (method === 'POST' && path === '/favourites/import') return { refs: ['m1', 'gen:g7', 'm9'], imported: 2, skipped: 0, echo: body }
    })
    await useFavourites.getState().sync()
    expect(calls).toEqual([expect.objectContaining({ method: 'POST', path: '/favourites/import', body: { refs: ['m1', 'g7'] } })])
    expect(localStorage.getItem('mixai.favourites')).toBeNull()
    // project rows come back as gen:<id>; the grid keys them by bare id
    expect(useFavourites.getState()).toMatchObject({ ids: ['m1', 'g7', 'm9'], mode: 'server' })

    // next visit: nothing to import, just the list
    const again = mockApi((_m, path) => (path === '/favourites' ? { refs: ['m1'] } : undefined))
    await useFavourites.getState().sync()
    expect(again.map((c) => c.path)).toEqual(['/favourites'])
    expect(useFavourites.getState().ids).toEqual(['m1'])
  })

  it('toggles on the server and puts the heart back if that fails', async () => {
    useFavourites.setState({ ids: [], mode: 'server' })
    mockApi(() => new Response('{"detail":"boom"}', { status: 500 }))
    expect(useFavourites.getState().toggle('m1')).toBe(true)
    expect(useFavourites.getState().ids).toEqual(['m1'])
    await vi.waitFor(() => expect(useFavourites.getState().ids).toEqual([]))
  })

  it('an older server without /favourites keeps the hearts in this browser', async () => {
    localStorage.setItem('mixai.favourites', JSON.stringify(['m1']))
    useFavourites.setState({ ids: ['m1'] })
    mockApi(() => new Response('{"detail":"Not Found"}', { status: 404 }))
    await useFavourites.getState().sync()
    expect(useFavourites.getState().mode).toBe('local')
    useFavourites.getState().toggle('m2')
    expect(JSON.parse(localStorage.getItem('mixai.favourites')!)).toEqual(['m2', 'm1'])
  })
})
