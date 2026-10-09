import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Lightbox } from '@/components/generate/Lightbox'
import { activeRail, MENUS, pageTitle } from '@/lib/nav'
import { shellRoutes } from '@/router'
import { media, mockApi, renderAt, T } from '@/test/media-fixtures'
import { PhotoStudioPickPage } from './PhotoStudioPickPage'

afterEach(() => vi.unstubAllGlobals())

describe('Photo Studio routing and entry points', () => {
  it('has a picker route and an editor route', () => {
    const paths = shellRoutes.map((r) => r.path)
    expect(paths).toContain('image/studio')
    expect(paths).toContain('image/studio/:generationId')
    expect(pageTitle('/image/studio/g-1')).toBe('Photo Studio')
    expect(activeRail('/image/studio')).toBe('image')
  })

  it('lists Photo Studio and Looks in the Image mega-menu', () => {
    const features = MENUS.image.features.map((f) => [f.title, f.description, f.to])
    expect(features).toContainEqual(['Photo Studio', 'Develop, restore, cut-out', '/image/studio'])
    expect(features).toContainEqual(['Looks', expect.any(String), '/image/studio?tab=looks'])
  })

  it('the picker opens the chosen picture in the editor', async () => {
    mockApi((_m, p) => (p === '/media' ? { items: [media('a', { title: 'Old harbour' })] } : undefined))
    renderAt('/image/studio', [{ path: '/image/studio', element: <PhotoStudioPickPage /> }])
    const user = userEvent.setup()
    expect(screen.getByRole('heading', { name: 'Photo Studio' })).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'View Old harbour' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/image/studio/g-a')
  })

  it('the Looks entry keeps the Looks tab through the picker', async () => {
    mockApi((_m, p) => (p === '/media' ? { items: [media('a', { title: 'Old harbour' })] } : undefined))
    renderAt('/image/studio?tab=looks', [{ path: '/image/studio', element: <PhotoStudioPickPage /> }])
    const user = userEvent.setup()
    expect(screen.getByRole('heading', { name: 'Looks' })).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'View Old harbour' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/image/studio/g-a?tab=looks')
  })

  it('the lightbox offers "Open in Photo Studio" for images only', () => {
    mockApi(() => undefined)
    const entry = { key: 'a', kind: 'image' as const, src: '/media/a.png', title: 'Old harbour', createdAt: T, generationId: 'g-a' }
    const { unmount } = renderAt('/', [{ path: '/', element: <Lightbox entries={[entry]} index={0} onIndex={() => {}} onClose={() => {}} actions={{}} /> }])
    expect(screen.getByRole('link', { name: 'Open in Photo Studio' })).toHaveAttribute('href', '/image/studio/g-a')
    unmount()
    renderAt('/', [{ path: '/', element: <Lightbox entries={[{ ...entry, kind: 'video' }]} index={0} onIndex={() => {}} onClose={() => {}} actions={{}} /> }])
    expect(screen.queryByRole('link', { name: 'Open in Photo Studio' })).not.toBeInTheDocument()
  })
})
