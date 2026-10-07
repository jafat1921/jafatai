import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageGeneratePage } from '@/features/image/ImageGeneratePage'
import { LibraryPage } from '@/features/library/LibraryPage'
import { seedCatalog } from '@/test/model-fixtures'
import { openChip } from '@/test/dock'
import { job, media, mockApi, renderAt, T } from '@/test/media-fixtures'

afterEach(() => vi.unstubAllGlobals())

const notFound = () => new Response('{"detail":"Not Found"}', { status: 404 })
const folders = [
  { id: 'f1', name: 'Spring', parent_id: null, kind: 'any', sort: 0, item_count: 0, created_at: T, updated_at: T },
  { id: 'f2', name: 'Clips', parent_id: null, kind: 'video', sort: 0, item_count: 0, created_at: T, updated_at: T },
]

describe('Generate into…', () => {
  it('a folder picked on the dock rides along with the request', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/folders') return folders
      if (path === '/media') return { items: [] }
      if (path === '/templates') return []
      if (path === '/estimate' || path === '/prompts/enhance') return notFound()
      if (method === 'POST' && path === '/images/generate') return { items: [media('n1', { media_url: null, folder_id: 'f1' })], jobs: [job('j1')] }
    })
    renderAt('/image/generate', [{ path: '/image/generate', element: <ImageGeneratePage /> }], seedCatalog)
    const user = userEvent.setup()
    expect(await screen.findByRole('button', { name: 'Into folder: Library' })).toBeInTheDocument()
    const pop = await openChip(user, 'Into folder')
    // video-only folders aren't offered for pictures
    expect(within(pop).queryByRole('button', { name: 'Clips' })).not.toBeInTheDocument()
    await user.click(within(pop).getByRole('button', { name: 'Spring' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Into folder: Spring' })).toBeInTheDocument()

    await user.click(screen.getByRole('textbox', { name: 'Describe the image' }))
    await user.paste('A kite over the dunes')
    await user.click(screen.getByRole('button', { name: /^Generate/ }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/images/generate')?.body).toMatchObject({ folder_id: 'f1' }))
  })

  it('no folders, no chip', async () => {
    mockApi((_m, path) => (path === '/media' ? { items: [] } : path === '/estimate' || path === '/prompts/enhance' ? notFound() : undefined))
    renderAt('/image/generate', [{ path: '/image/generate', element: <ImageGeneratePage /> }], seedCatalog)
    await screen.findByRole('group', { name: 'Settings' })
    expect(screen.queryByRole('button', { name: /^Into folder/ })).not.toBeInTheDocument()
  })
})

describe('lightbox before / after', () => {
  it('C compares an upscaled version with the one it came from', async () => {
    const up = media('u1', { title: 'Harbour', generation_id: 'g2', media_url: '/big.png' })
    mockApi((_m, path) => {
      if (path === '/media') return { items: [up] }
      if (path === '/media/u1')
        return {
          ...up,
          versions: [
            { id: 'g2', version: 2, kind: 'image', status: 'ready', media_url: '/big.png', parent_id: 'g1', params: { upscale: { target: '2x', engine: 'quick', source_id: 'g1' } }, created_at: T },
            { id: 'g1', version: 1, kind: 'image', status: 'ready', media_url: '/small.png', params: {}, created_at: T },
          ],
        }
    })
    renderAt('/image/library', [{ path: '/image/library', element: <LibraryPage kind="image" /> }])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'View Harbour' }))
    const box = await screen.findByRole('dialog', { name: 'Harbour' })
    const button = await within(box).findByRole('button', { name: /Before \/ after/ })
    fireEvent.keyDown(box, { key: 'c' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(within(box).getByRole('img', { name: 'Original · v1: Harbour' })).toHaveAttribute('src', '/small.png')
    expect(within(box).getByRole('slider', { name: 'Before and after divider' })).toBeInTheDocument()
    // L reaches the loupe from anywhere in the lightbox
    fireEvent.keyDown(document.body, { key: 'l' })
    expect(within(box).getByRole('button', { name: /1:1 loupe/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(box, { key: 'c' })
    expect(within(box).queryByRole('slider', { name: 'Before and after divider' })).not.toBeInTheDocument()
  })
})
