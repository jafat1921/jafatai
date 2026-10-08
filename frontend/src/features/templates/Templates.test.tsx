import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageGeneratePage } from '@/features/image/ImageGeneratePage'
import { ProjectsPage } from '@/features/projects/ProjectsPage'
import { QuickCreatePage } from '@/features/quick/QuickCreatePage'
import type { Template } from '@/lib/types'
import { mockApi, renderAt } from '@/test/media-fixtures'
import { TemplatesPage } from './TemplatesPage'

afterEach(() => vi.unstubAllGlobals())

const ad: Template = {
  id: 'ad30',
  type: 'video',
  title: '30 s product ad',
  description: 'Hero shot, three benefits, logo end card.',
  category: 'Ads & brand',
  tags: ['advert'],
  examples: { product: 'a camping lantern', brand: 'Lumen' },
  preview_url: '/api/prompt-templates/ad30/preview?v=1',
  defaults: { prompt_scaffold: 'A 30 second ad for [product] by [brand]', duration_s: 30, aspect_ratio: '16:9', style: 'commercial' },
}
const film: Template = {
  id: 'short',
  type: 'video',
  title: 'Short film',
  description: 'Five minutes, written with the AI Director.',
  category: 'Cinematic scenes',
  tags: ['drama'],
  defaults: { authoring_mode: 'ai_director', logline_hint: 'A [character] must [goal] before [deadline]', target_runtime_s: 300 },
}
const portrait: Template = {
  id: 'portrait',
  type: 'image',
  title: 'Portrait',
  description: 'Soft key light, shallow depth of field.',
  category: 'Portraits',
  tags: ['headshot'],
  examples: { subject: 'a potter in her studio' },
  preview_url: '/api/prompt-templates/portrait/preview?v=1',
  defaults: { prompt_scaffold: 'Portrait of [subject], 85mm', aspect: '3:4', count: 4 },
}
const eid: Template = {
  id: 'eid',
  type: 'image',
  title: 'Urdu greeting poster',
  description: 'Calligraphy for Eid.',
  category: 'Posters & text',
  tags: ['urdu', 'calligraphy'],
  examples: { greeting: 'عید مبارک' },
  preview_url: null,
  defaults: { prompt_scaffold: 'Poster with the Urdu text "[greeting]"', aspect: '2:3', count: 2, model: 'qwen_image_2512' },
}

const routes = [
  { path: '/video/prompt-templates', element: <TemplatesPage type="video" /> },
  { path: '/image/prompt-templates', element: <TemplatesPage type="image" /> },
  { path: '/video/quick', element: <QuickCreatePage /> },
  { path: '/video/projects', element: <ProjectsPage /> },
  { path: '/image/generate', element: <ImageGeneratePage /> },
]

function api(start: (id: string) => unknown) {
  return mockApi((method, path, q) => {
    if (path === '/prompt-templates') return q.type === 'image' ? [portrait, eid] : [ad, film]
    const m = path.match(/^\/prompt-templates\/(\w+)\/start$/)
    if (method === 'POST' && m) return start(m[1])
    if (path === '/media') return { items: [] }
  })
}

describe('prompt templates', () => {
  it('shows cards with the placeholders highlighted', async () => {
    api(() => undefined)
    renderAt('/video/prompt-templates', routes)
    const card = (await screen.findByRole('heading', { name: '30 s product ad' })).closest('article')!
    expect(within(card).getByText('[product]').tagName).toBe('MARK')
    expect(within(card).getByText(/30s · 16:9 · Quick video/)).toBeInTheDocument()
  })

  it('opens Quick Create prefilled and waits for the user to replace the placeholders', async () => {
    const calls = api(() => ({ target: 'quick', prefill: ad.defaults }))
    renderAt('/video/prompt-templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the 30 s product ad prompt template' }))

    const prompt = await screen.findByRole('textbox', { name: 'Describe your video' })
    expect(screen.getByTestId('location')).toHaveTextContent('/video/quick')
    expect(prompt).toHaveValue('A 30 second ad for [product] by [brand]')
    expect(screen.getByText('Prompt template: 30 s product ad')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Style: Commercial' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create video/ })).toBeDisabled()
    expect(screen.getByText('Replace [product], [brand] first.')).toBeInTheDocument()

    // clicking a slot selects it, so typing replaces it
    await user.click(screen.getByRole('button', { name: 'Select [product] in the prompt' }))
    await user.keyboard('Lumen lamps')
    await user.click(screen.getByRole('button', { name: 'Select [brand] in the prompt' }))
    await user.keyboard('Atelier')
    expect(prompt).toHaveValue('A 30 second ad for Lumen lamps by Atelier')
    expect(screen.getByRole('button', { name: /Create video/ })).toBeEnabled()
    expect(calls.some((c) => c.path === '/quick')).toBe(false)
  })

  it('opens the new-project dialog for a studio template, without creating anything', async () => {
    const calls = api(() => ({ target: 'studio', prefill: film.defaults }))
    renderAt('/video/prompt-templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Short film prompt template' }))

    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('Short film')
    expect(within(dialog).getByRole('textbox', { name: 'Brief' })).toHaveValue('A [character] must [goal] before [deadline]')
    expect(within(dialog).getByRole('radio', { name: '5 min' })).toBeChecked()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/projects')).toBe(false)
  })

  it('prefills Create Image, falling back to the template defaults if /start is missing', async () => {
    const calls = api(() => new Response('{"detail":"Not Found"}', { status: 404 }))
    renderAt('/image/prompt-templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Portrait prompt template' }))

    expect(await screen.findByRole('textbox', { name: 'Describe the image' })).toHaveValue('Portrait of [subject], 85mm')
    expect(screen.getByTestId('location')).toHaveTextContent('/image/generate')
    expect(screen.getByRole('button', { name: 'Aspect: 3:4' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Count: ×4' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Generate/ })).toBeDisabled()
    expect(calls.some((c) => c.path === '/images/generate')).toBe(false)
  })

  it('shows the preview picture, or the icon when there is none', async () => {
    api(() => undefined)
    renderAt('/image/prompt-templates', routes)
    const card = (await screen.findByRole('heading', { name: 'Portrait' })).closest('article')!
    const img = within(card).getByRole('img', { name: 'Example: Portrait' })
    expect(img).toHaveAttribute('src', '/api/prompt-templates/portrait/preview?v=1')
    expect(img).toHaveAttribute('loading', 'lazy')
    const eidCard = screen.getByRole('heading', { name: 'Urdu greeting poster' }).closest('article')!
    expect(within(eidCard).queryByRole('img')).not.toBeInTheDocument()
    expect(within(eidCard).getByTestId('preview-fallback')).toBeInTheDocument()
    expect(within(eidCard).getByText(/Qwen text/)).toBeInTheDocument()
    // a broken file falls back too
    fireEvent.error(img)
    expect(within(card).getByTestId('preview-fallback')).toBeInTheDocument()
  })

  it('filters by category chip and by search', async () => {
    api(() => undefined)
    renderAt('/image/prompt-templates', routes)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Portrait' })
    const chips = within(screen.getByRole('group', { name: 'Category' }))
    expect(chips.getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Portraits', 'Posters & text'])

    await user.click(chips.getByRole('button', { name: 'Posters & text' }))
    expect(chips.getByRole('button', { name: 'Posters & text' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('heading', { name: 'Portrait' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Urdu greeting poster' })).toBeInTheDocument()
    await user.click(chips.getByRole('button', { name: 'All' }))

    const search = screen.getByRole('searchbox', { name: 'Search prompt templates' })
    await user.type(search, 'headshot') // tags count too
    expect(screen.getByRole('heading', { name: 'Portrait' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Urdu greeting poster' })).not.toBeInTheDocument()
    await user.clear(search)
    await user.type(search, 'zebra')
    expect(screen.getByText('Nothing matches')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('a text template opens Create Image with its example hints on the slots', async () => {
    api((id) => (id === 'eid' ? { target: 'image', prefill: { prompt: eid.defaults.prompt_scaffold, aspect: '2:3', count: 2, model: 'qwen_image_2512' } } : undefined))
    renderAt('/image/prompt-templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Urdu greeting poster prompt template' }))
    expect(await screen.findByRole('textbox', { name: 'Describe the image' })).toHaveValue('Poster with the Urdu text "[greeting]"')
    expect(screen.getByText('Prompt template: Urdu greeting poster')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select [greeting] in the prompt' })).toHaveAttribute('title', 'e.g. عید مبارک')
  })

  it("the dock's picker lists prompt templates with small previews", async () => {
    api(() => undefined)
    renderAt('/image/generate', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Start from a prompt template/ }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Image prompt templates')).toBeInTheDocument()
    const item = await within(menu).findByRole('menuitem', { name: /Portrait/ })
    expect(item.querySelector('img')).toHaveAttribute('src', '/api/prompt-templates/portrait/preview?v=1')
    expect(within(menu).getByRole('menuitem', { name: /Urdu greeting poster/ }).querySelector('[data-testid="preview-fallback"]')).not.toBeNull()

    await user.click(item)
    expect(screen.getByRole('textbox', { name: 'Describe the image' })).toHaveValue('Portrait of [subject], 85mm')
    expect(screen.getByText('Prompt template: Portrait')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select [subject] in the prompt' })).toHaveAttribute('title', 'e.g. a potter in her studio')
  })
})
