import type { QueryClient } from '@tanstack/react-query'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CharacterPage } from '@/features/characters/CharacterPage'
import { ProductsSection } from '@/features/brand/ProductsSection'
import { make3dHref, startFromQuery } from '@/lib/model3d'
import type { Character, Generation, Usage } from '@/lib/types'
import { mockApi, renderAt, T } from '@/test/media-fixtures'
import { Lightbox, type LightboxEntry } from './Lightbox'
import { Make3DLink } from './Make3DLink'

afterEach(() => vi.unstubAllGlobals())

// what GET /api/account/usage says about the package; only `features` matters here
const without3d = (qc: QueryClient) => qc.setQueryData(['account-usage'], { package: { id: 'p', name: 'Basic', kind: 'paid' }, features: { '3d': false } } as unknown as Usage)

const entry: LightboxEntry = { key: 'a', kind: 'image', src: '/media/a.png', title: 'Old harbour', createdAt: T, generationId: 'g-a', mediaId: 'a' }
const lightbox = (e: LightboxEntry, onClose = () => {}) => [{ path: '/', element: <Lightbox entries={[e]} index={0} onIndex={() => {}} onClose={onClose} actions={{}} /> }]

describe('Make 3D links', () => {
  it('build the query the 3D Studio opens with', () => {
    expect(make3dHref({ picture: 'm 1' })).toBe('/3d?from=picture&source=m%201')
    expect(make3dHref({ character: 'c1' })).toBe('/3d?character=c1')
    expect(startFromQuery(new URLSearchParams('from=picture&source=m1'))).toMatchObject({ from: 'picture', sourceId: 'm1' })
    expect(startFromQuery(new URLSearchParams('image=m2'))).toMatchObject({ from: 'picture', sourceId: 'm2' })
    expect(startFromQuery(new URLSearchParams('character=c1'))).toMatchObject({ from: 'character', characterId: 'c1', sourceId: null })
  })

  it('the lightbox offers it on Library pictures and goes to the studio', async () => {
    mockApi(() => undefined)
    const onClose = vi.fn()
    renderAt('/', [...lightbox(entry, onClose), { path: '/3d', element: <p>studio</p> }])
    const link = screen.getByRole('link', { name: 'Make 3D' })
    expect(link).toHaveAttribute('href', '/3d?from=picture&source=a')
    await userEvent.setup().click(link)
    expect(screen.getByTestId('location')).toHaveTextContent('/3d?from=picture&source=a')
    expect(onClose).toHaveBeenCalled()
  })

  it('isn’t offered on videos, on pictures outside the Library, or without 3D Studio in the package', () => {
    mockApi(() => undefined)
    const a = renderAt('/', lightbox({ ...entry, kind: 'video' }))
    expect(screen.queryByRole('link', { name: 'Make 3D' })).not.toBeInTheDocument()
    a.unmount()
    const b = renderAt('/', lightbox({ ...entry, mediaId: undefined }))
    expect(screen.queryByRole('link', { name: 'Make 3D' })).not.toBeInTheDocument()
    b.unmount()
    renderAt('/', lightbox(entry), without3d)
    expect(screen.queryByRole('link', { name: 'Make 3D' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Photo Studio' })).toBeInTheDocument()
  })

  it('opens in a new tab from a form, and says so', () => {
    renderAt('/', [{ path: '/', element: <Make3DLink start={{ picture: 'p1' }} ariaLabel="Make 3D from product 1" newTab /> }])
    const link = screen.getByRole('link', { name: 'Make 3D from product 1 (opens in a new tab)' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('href', '/3d?from=picture&source=p1')
  })

  it('a brand kit product links its picture', () => {
    renderAt('/', [{ path: '/', element: <ProductsSection products={[{ media_id: 'p1', name: 'Cold brew can', description: '' }]} urls={{ p1: '/t/p1.webp' }} onChange={() => {}} /> }])
    expect(screen.getByRole('link', { name: /Make 3D from Cold brew can/ })).toHaveAttribute('href', '/3d?from=picture&source=p1')
  })
})

describe('Make 3D on a character', () => {
  const portrait = { id: 'g-p', status: 'ready', media_url: '/m/p.png', thumb_url: '/t/p.webp' } as Generation
  const character = (extra: Partial<Character> = {}): Character => ({
    id: 'c1', project_id: null, name: 'Maya', description: '', source: 'user', locked: true, profile: {}, voice_id: null,
    studio: true, approved_portrait: null, portrait, panels_ready: 0, films: [], ...extra,
  })
  const page = (c: Character, seed?: (qc: QueryClient) => void) => {
    mockApi((_m, path) => (path === '/characters/c1' ? c : undefined))
    return renderAt('/characters/c1', [{ path: '/characters/:characterId', element: <CharacterPage /> }], seed)
  }

  it('opens the studio with the character picked', async () => {
    page(character())
    expect(await screen.findByRole('link', { name: 'Make 3D model of Maya' })).toHaveAttribute('href', '/3d?character=c1')
  })

  it('waits for a portrait, and follows the package', async () => {
    const a = page(character({ portrait: null }))
    expect(await screen.findByRole('heading', { name: 'Maya' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Make 3D/ })).not.toBeInTheDocument()
    a.unmount()
    vi.unstubAllGlobals()
    page(character(), without3d)
    expect(await screen.findByRole('heading', { name: 'Maya' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Make 3D/ })).not.toBeInTheDocument()
  })
})
