import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageGeneratePage } from '@/features/image/ImageGeneratePage'
import { Img2VidPage } from '@/features/video/Img2VidPage'
import { LibraryPage } from '@/features/library/LibraryPage'
import { job, media, mockApi, renderAt, T } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'

afterEach(() => vi.unstubAllGlobals())

const fox = media('f1', { title: 'Fox', prompt: 'A fox in the snow', params: { model: 'auto', model_resolved: 'qwen_image_2512' } })
const owl = media('o1', { title: 'Owl', prompt: 'An owl at night', created_at: '2026-10-07T09:00:00Z' })

function api(items = [fox, owl]) {
  return mockApi((method, path) => {
    if (path === '/media') return { items }
    if (path === '/templates' || path === '/brand-kits') return []
    if (path === '/estimate') return new Response('', { status: 404 })
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...(items.find((m) => m.id === id) ?? media(id)), versions: [] }
    if (method === 'POST' && path === '/images/generate') return { items: [media(`n${Math.random().toString(36).slice(2, 6)}`, { media_url: null, created_at: T })], jobs: [job('j9')] }
  })
}

const routes = [
  { path: '/image/generate', element: <ImageGeneratePage /> },
  { path: '/video/img2vid', element: <Img2VidPage /> },
]

describe('session rows', () => {
  it('Retry re-sends the same request; Reuse settings refills the dock', async () => {
    const calls = api([])
    renderAt('/image/generate', routes, seedCatalog)
    const user = userEvent.setup()
    const prompt = screen.getByRole('textbox', { name: 'Describe the image' })
    await user.click(prompt)
    await user.paste('A fox in the snow')
    await user.click(screen.getByRole('button', { name: /^Generate/ }))
    const row = await screen.findByRole('listitem', { name: 'Request: A fox in the snow' })

    await user.click(within(row).getByRole('button', { name: 'Retry' }))
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1].body).toEqual(posts[0].body)

    await user.clear(prompt)
    await user.paste('Something else')
    await user.click(within(screen.getAllByRole('listitem', { name: 'Request: A fox in the snow' })[0]).getByRole('button', { name: 'Reuse settings' }))
    expect(screen.getByRole('textbox', { name: 'Describe the image' })).toHaveValue('A fox in the snow')
  })

  it('history rows reuse the prompt and the model that made them, and show it on the tile', async () => {
    api()
    renderAt('/image/generate', routes, seedCatalog)
    const user = userEvent.setup()
    const row = await screen.findByRole('listitem', { name: 'Request: A fox in the snow' })
    // the model Auto actually picked, from params.model_resolved
    expect(within(row).getByTitle('Made with Qwen-Image 2512')).toHaveTextContent('Made with Qwen-Image 2512')
    await user.click(within(row).getByRole('button', { name: 'Reuse settings' }))
    expect(screen.getByRole('textbox', { name: 'Describe the image' })).toHaveValue('A fox in the snow')
    expect(screen.getByRole('button', { name: /^Model: Qwen-Image 2512/ })).toBeInTheDocument()
  })
})

describe('tile actions', () => {
  it('Animate opens Image to Video with the picture as the start frame', async () => {
    api()
    renderAt('/image/generate', routes, seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Animate Fox' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/video/img2vid?image=f1')
    const dock = screen.getByRole('form', { name: 'Image to Video' })
    expect(await within(dock).findByRole('img', { name: 'Fox' })).toBeInTheDocument()
    // only the motion is missing now
    expect(within(dock).getByText('Describe the motion first.')).toBeInTheDocument()
  })

  it('Use as reference opens Edit with it; the heart is remembered in this browser', async () => {
    api()
    renderAt('/image/generate', routes, seedCatalog)
    const user = userEvent.setup()
    const heart = await screen.findByRole('button', { name: 'Favourite Owl' })
    await user.click(heart)
    expect(heart).toHaveAttribute('aria-pressed', 'true')
    expect(JSON.parse(localStorage.getItem('mixai.favourites')!)).toEqual(['o1'])
    await user.click(screen.getByRole('button', { name: 'Use as reference: Owl' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/image/edit?sources=o1')
  })
})

describe('lightbox', () => {
  it('browses with arrows and acts with F, E and Esc', async () => {
    api()
    renderAt('/image/library', [...routes, { path: '/image/library', element: <LibraryPage kind="image" /> }, { path: '/image/edit', element: <p>edit page</p> }], seedCatalog)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'View Fox' }))
    let box = await screen.findByRole('dialog', { name: 'Fox' })
    expect(within(box).getByText('1 of 2')).toBeInTheDocument()
    expect(within(box).getByText('A fox in the snow')).toBeInTheDocument()
    expect(within(box).getByText('Qwen-Image 2512')).toBeInTheDocument()

    fireEvent.keyDown(box, { key: 'ArrowRight' })
    box = await screen.findByRole('dialog', { name: 'Owl' })
    fireEvent.keyDown(box, { key: 'f' })
    expect(within(box).getByRole('button', { name: /Favourite/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(box, { key: 'ArrowLeft' })
    expect(await screen.findByRole('dialog', { name: 'Fox' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'View Owl' }))
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Owl' }), { key: 'e' })
    expect(screen.getByTestId('location')).toHaveTextContent('/image/edit?sources=o1')
  })

  it('A animates; Reuse all settings goes back to Create with the prompt', async () => {
    api()
    renderAt('/image/library', [...routes, { path: '/image/library', element: <LibraryPage kind="image" /> }])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'View Fox' }))
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Fox' }), { key: 'a' })
    expect(screen.getByTestId('location')).toHaveTextContent('/video/img2vid?image=f1')
  })
})
