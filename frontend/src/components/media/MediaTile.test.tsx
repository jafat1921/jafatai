import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TileHandlers } from '@/components/generate/TileMenu'
import { formatDuration } from '@/lib/duration'
import { job, media, renderAt } from '@/test/media-fixtures'
import type { Job, MediaItem } from '@/lib/types'
import { MediaTile } from './MediaTile'

const handlers = (): TileHandlers => ({
  open: vi.fn(),
  details: vi.fn(),
  regenerate: vi.fn(),
  upscale: vi.fn(),
  remove: vi.fn(),
  edit: vi.fn(),
  img2img: vi.fn(),
  animate: vi.fn(),
  onUseAsRef: vi.fn(),
  favourite: vi.fn(),
  move: vi.fn(),
  rename: vi.fn(),
  reuse: vi.fn(),
  refLabel: 'Use as reference',
})

function show(item: MediaItem, opts: { h?: TileHandlers; jobs?: Job[]; onToggle?: () => void } = {}) {
  const h = opts.h ?? handlers()
  renderAt(
    '/',
    [{ path: '/', element: <MediaTile item={item} selectable onToggle={opts.onToggle ?? vi.fn()} handlers={h} /> }],
    (qc) => qc.setQueryData(['jobs'], opts.jobs ?? []),
  )
  return h
}

async function menuItems(name: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: `More for ${name}` }))
  const menu = await screen.findByRole('menu')
  return { user, menu, names: within(menu).getAllByRole('menuitem').map((m) => m.textContent?.trim()) }
}

describe('tile menu per item type', () => {
  it('standalone upscaled image: everything, including original download, rename and delete', async () => {
    const item = media('a', { title: 'The Luminous Tree', original_generation_id: 'g-orig', upscale: { target: '4k', label: '4K' }, thumb_url: '/api/media/thumb/g-a?w=512' })
    const h = show(item)
    const { user, menu, names } = await menuItems('The Luminous Tree')
    expect(names).toEqual([
      'Open', 'Versions', 'Download', 'Download original', 'Upscale…', 'Edit', 'Image to Image', 'Animate → Image to Video', 'Use as reference',
      'Regenerate: same prompt, new seed', 'Regenerate with note…', 'Edit prompt & regenerate…', 'Move to folder…', 'Favourite', 'Rename', 'Delete',
    ])
    expect(within(menu).getByRole('menuitem', { name: 'Download original' })).toHaveAttribute('href', '/api/generations/g-orig/download')
    expect(within(menu).getByRole('menuitem', { name: 'Download' })).toHaveAttribute('href', '/api/generations/g-a/download')
    await user.click(within(menu).getByRole('menuitem', { name: 'Image to Image' }))
    expect(h.img2img).toHaveBeenCalledWith(item)
  })

  it('upload that was never upscaled: no original download, no regenerate', async () => {
    show(media('u', { title: 'pic122', origin: 'upload' }))
    const { names } = await menuItems('pic122')
    expect(names).not.toContain('Download original')
    expect(names).not.toContain('Regenerate: same prompt, new seed')
    expect(names).toContain('Rename')
  })

  it('project video: no image tools, and "Manage in project" instead of rename/delete', async () => {
    show(media('r', { title: 'Full film', kind: 'video', origin: 'project', project_id: 'p1', duration_s: 65 }))
    const { menu, names } = await menuItems('Full film')
    expect(names).not.toContain('Edit')
    expect(names).not.toContain('Image to Image')
    expect(names).not.toContain('Delete')
    expect(names).not.toContain('Rename')
    expect(names).toContain('Upscale…')
    expect(within(menu).getByRole('menuitem', { name: 'Manage in project' })).toHaveAttribute('href', '/projects/p1/output')
  })

  it('a click on the menu never toggles the tile', async () => {
    const onToggle = vi.fn()
    show(media('a', { title: 'Fox' }), { onToggle })
    const { user, menu } = await menuItems('Fox')
    await user.click(within(menu).getByRole('menuitem', { name: 'Versions' }))
    expect(onToggle).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Fox' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('tile states', () => {
  it('uses the thumb, lazily, behind a skeleton until it loads', () => {
    show(media('a', { title: 'Fox', thumb_url: '/api/media/thumb/g-a?w=512' }))
    const img = screen.getByRole('img', { name: 'Fox' })
    expect(img).toHaveAttribute('src', '/api/media/thumb/g-a?w=512')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('decoding', 'async')
    expect(screen.getByTestId('tile-skeleton')).toBeInTheDocument()
    fireEvent.load(img)
    expect(screen.queryByTestId('tile-skeleton')).not.toBeInTheDocument()
  })

  it('retries a broken picture once, then says "Preview unavailable"', () => {
    show(media('a', { title: 'Fox', thumb_url: '/api/media/thumb/g-a?w=512' }))
    fireEvent.error(screen.getByRole('img', { name: 'Fox' }))
    expect(screen.getByRole('img', { name: 'Fox' })).toHaveAttribute('src', '/api/media/thumb/g-a?w=512&retry=1')
    fireEvent.error(screen.getByRole('img', { name: 'Fox' }))
    expect(screen.getByRole('img', { name: 'Fox: preview unavailable' })).toHaveTextContent('Preview unavailable')
  })

  it('a video with a server thumb is an <img> poster with a play badge and duration', () => {
    const { container } = renderAt('/', [
      { path: '/', element: <MediaTile item={media('v', { title: 'Reel', kind: 'video', duration_s: 75, thumb_url: '/api/media/thumb/g-v?w=512', media_url: '/m/v.mp4' })} /> },
    ])
    expect(screen.getByRole('img', { name: 'Reel' })).toHaveAttribute('src', '/api/media/thumb/g-v?w=512')
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByText(formatDuration(75))).toBeInTheDocument()
  })

  it('shows Generating with a percentage while its job runs', () => {
    const running = media('a', { title: 'Fox', status: 'generating', media_url: null })
    show(running, { jobs: [job('j1', { status: 'running', progress: 0.42, generation_id: 'g-a' })] })
    expect(screen.getByText('Generating… 42%')).toBeInTheDocument()
  })

  it('failed items say so and offer Retry', async () => {
    const h = handlers()
    show(media('b', { title: 'Owl', status: 'failed', media_url: null }), { h, jobs: [job('j2', { status: 'failed', error: 'Out of memory', generation_id: 'g-b' })] })
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Out of memory')).toBeInTheDocument()
    const { user, menu } = await menuItems('Owl')
    await user.click(within(menu).getByRole('menuitem', { name: 'Retry' }))
    expect(h.regenerate).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'same')
  })

  it('badges an item whose current version is an upscale', () => {
    show(media('a', { title: 'Fox', upscale: { target: '2k', label: '2K' } }))
    expect(screen.getByText('Upscaled · 2K')).toBeInTheDocument()
  })
})
