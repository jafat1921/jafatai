import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, type InfiniteData } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import { libraryFilter, upsertMedia, wantsHome, type MediaFilter } from '@/hooks/useMedia'
import type { MediaPage } from '@/lib/types'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { ImageReferencesPage } from '@/features/image/ImageReferencesPage'
import { LibraryPage } from './LibraryPage'

afterEach(() => vi.unstubAllGlobals())

const seed = (qc: QueryClient, filter: MediaFilter) =>
  qc.setQueryData<InfiniteData<MediaPage>>(qk.mediaList(filter), { pages: [{ items: [] }], pageParams: [undefined] })
const ids = (qc: QueryClient, filter: MediaFilter) =>
  qc.getQueryData<InfiniteData<MediaPage>>(qk.mediaList(filter))?.pages[0].items.map((m) => m.id)

describe('studio parts', () => {
  it('only lets a part into lists that asked for its studio', () => {
    expect(wantsHome({ kind: 'image' }, null)).toBe(true)
    expect(wantsHome({ kind: 'image' }, 'character')).toBe(false)
    expect(wantsHome({ kind: 'image', include_home: 'character' }, 'character')).toBe(true)
    expect(wantsHome({ kind: 'image', include_home: 'character' }, 'poetry')).toBe(false)
    expect(wantsHome({ kind: 'image', home: 'any' }, 'poetry')).toBe(true)
    expect(wantsHome({ kind: 'image', home: 'any' }, null)).toBe(false)
    expect(wantsHome({ kind: 'video', home: 'story:1' }, 'story:2')).toBe(false)
  })

  it('drops a live-pushed part from the generator history but keeps it for References', () => {
    const qc = new QueryClient()
    const history: MediaFilter = { kind: 'image', origin: 'generated' }
    const refs: MediaFilter = { kind: 'image', include: 'project', include_home: 'character' }
    seed(qc, history)
    seed(qc, refs)
    upsertMedia(qc, media('board', { home: 'character' }))
    upsertMedia(qc, media('final'))
    expect(ids(qc, history)).toEqual(['final'])
    expect(ids(qc, refs)).toEqual(['final', 'board'])
  })

  it('References asks for character parts too', async () => {
    const calls = mockApi((_m, path) => (path === '/media' ? { items: [media('a')] } : undefined))
    renderAt('/image/references', [{ path: '/image/references', element: <ImageReferencesPage /> }])
    await screen.findByRole('button', { name: 'Image a' })
    expect(calls.find((c) => c.path === '/media')?.query).toMatchObject({ include_home: 'character' })
  })

  it('the Studio parts chip lists every studio part', async () => {
    expect(libraryFilter('image', 'all', '', null, { parts: true })).toEqual({ kind: 'image', include: 'project', home: 'any' })
    const calls = mockApi((_m, path, q) => {
      if (path !== '/media') return
      return { items: q.home === 'any' ? [media('p', { title: 'Mira · character sheet', home: 'character' })] : [media('a', { title: 'Reef' })] }
    })
    renderAt('/image/library', [{ path: '/image/library', element: <LibraryPage kind="image" /> }])
    const user = userEvent.setup()
    expect(await screen.findByRole('img', { name: 'Reef' })).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/media')?.query.home).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Studio parts' }))
    expect(await screen.findByRole('img', { name: 'Mira · character sheet' })).toBeInTheDocument()
    await waitFor(() => expect(calls.at(-1)?.query).toMatchObject({ home: 'any' }))
  })
})
