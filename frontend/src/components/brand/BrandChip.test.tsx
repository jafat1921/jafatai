import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageEditPage } from '@/features/image/ImageEditPage'
import { ImageGeneratePage } from '@/features/image/ImageGeneratePage'
import { QuickCreateForm } from '@/features/quick/QuickCreateForm'
import { VideoCreatePage } from '@/features/video/VideoCreatePage'
import { withBrand } from '@/lib/brand'
import { kit } from '@/test/brand-fixtures'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { closeChip, openChip } from '@/test/dock'

afterEach(() => vi.unstubAllGlobals())

const KITS = [kit('k1', { name: 'Leaf', is_default: true }), kit('k2', { name: 'Stone' })]

function api(kits = KITS) {
  return mockApi((method, path) => {
    if (path === '/brand-kits') return kits
    if (path === '/media') return { items: [] }
    if (path === '/prompt-templates') return []
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id), versions: [] }
    if (method === 'POST') return { items: [], jobs: [], project: { id: 'p9', title: 'x' }, job: null }
  })
}

const posted = (calls: ReturnType<typeof api>) => calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>

describe('brand chip', () => {
  it('adds the kit only when on', () => {
    expect(withBrand({ a: 1 }, 'k1')).toEqual({ a: 1, brand_kit_id: 'k1' })
    expect(withBrand({ a: 1 }, undefined)).toEqual({ a: 1 })
  })

  it('Create Image: preselects the default kit and sends it', async () => {
    const calls = api()
    renderAt('/image/generate', [{ path: '/image/generate', element: <ImageGeneratePage /> }], seedCatalog)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: /^Brand: Leaf/ })
    const chip = await openChip(user, 'Brand')
    expect(within(chip).getByRole('combobox', { name: 'Brand:' })).toHaveValue('k1')
    expect(within(chip).getByRole('switch', { name: 'Use the brand kit' })).toBeChecked()
    await closeChip(user)
    await user.click(screen.getByRole('textbox', { name: 'Describe the image' }))
    await user.paste('A cup of cold brew on a counter')
    await user.click(screen.getByRole('button', { name: /^Generate/ }))
    expect(posted(calls)).toMatchObject({ prompt: 'A cup of cold brew on a counter', brand_kit_id: 'k1' })
  })

  it('Create Video: another kit can be picked, and Off sends none', async () => {
    const calls = api()
    renderAt('/video/create', [{ path: '/video/create', element: <VideoCreatePage /> }], seedCatalog)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: /^Brand: Leaf/ })
    await user.selectOptions(within(await openChip(user, 'Brand')).getByRole('combobox', { name: 'Brand:' }), 'k2')
    await closeChip(user)
    expect(screen.getByRole('button', { name: /^Brand: Stone/ })).toBeInTheDocument()
    await user.click(screen.getByRole('textbox', { name: 'Describe the clip' }))
    await user.paste('Steam rising from a cup')
    await user.click(screen.getByRole('button', { name: /^Render/ }))
    expect(posted(calls).brand_kit_id).toBe('k2')

    calls.length = 0
    const chip = await openChip(user, 'Brand')
    await user.click(within(chip).getByRole('switch', { name: 'Use the brand kit' }))
    expect(within(chip).getByText('Off')).toBeInTheDocument()
    await closeChip(user)
    expect(screen.getByRole('button', { name: 'Brand: Stone (off)' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Render/ }))
    expect(posted(calls)).not.toHaveProperty('brand_kit_id')
  })

  it('Edit Image and Quick Create carry the kit too', async () => {
    const calls = api()
    renderAt('/image/edit?sources=a', [{ path: '/image/edit', element: <ImageEditPage /> }], seedCatalog)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: /^Brand: Leaf/ })
    await user.type(screen.getByRole('textbox', { name: 'What should change?' }), 'Put the logo on the mug')
    await user.click(screen.getByRole('button', { name: /^Edit/ }))
    expect(posted(calls)).toMatchObject({ source_ids: ['a'], brand_kit_id: 'k1' })
  })

  it('Quick Create sends the default kit', async () => {
    const calls = api()
    renderAt('/q', [{ path: '/q', element: <QuickCreateForm expanded /> }])
    const user = userEvent.setup()
    await screen.findByRole('button', { name: /^Brand: Leaf/ })
    await user.click(screen.getByRole('textbox', { name: 'Describe your video' }))
    await user.paste('A 30 second advert for cold brew')
    await user.click(screen.getByRole('button', { name: /Create video/ }))
    expect(posted(calls)).toMatchObject({ prompt: 'A 30 second advert for cold brew', brand_kit_id: 'k1' })
  })

  it('with no kits it is off and points to Brand Kits', async () => {
    const calls = api([])
    renderAt('/image/generate', [{ path: '/image/generate', element: <ImageGeneratePage /> }], seedCatalog)
    const user = userEvent.setup()
    expect(await within(await openChip(user, 'Brand')).findByRole('link', { name: 'Create a brand kit' })).toHaveAttribute('href', '/brand-kits')
    await closeChip(user)
    await user.click(screen.getByRole('textbox', { name: 'Describe the image' }))
    await user.paste('A plain mug')
    await user.click(screen.getByRole('button', { name: /^Generate/ }))
    expect(posted(calls)).not.toHaveProperty('brand_kit_id')
  })
})
