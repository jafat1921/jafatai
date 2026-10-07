import { screen, within } from '@testing-library/react'
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
  defaults: { prompt_scaffold: 'A 30 second ad for [product] by [brand]', duration_s: 30, aspect_ratio: '16:9', style: 'commercial' },
}
const film: Template = {
  id: 'short',
  type: 'video',
  title: 'Short film',
  description: 'Five minutes, written with the AI Director.',
  defaults: { authoring_mode: 'ai_director', logline_hint: 'A [character] must [goal] before [deadline]', target_runtime_s: 300 },
}
const portrait: Template = {
  id: 'portrait',
  type: 'image',
  title: 'Portrait',
  description: 'Soft key light, shallow depth of field.',
  defaults: { prompt_scaffold: 'Portrait of [subject], 85mm', aspect: '3:4', count: 4 },
}

const routes = [
  { path: '/video/templates', element: <TemplatesPage type="video" /> },
  { path: '/image/templates', element: <TemplatesPage type="image" /> },
  { path: '/video/quick', element: <QuickCreatePage /> },
  { path: '/video/projects', element: <ProjectsPage /> },
  { path: '/image/generate', element: <ImageGeneratePage /> },
]

function api(start: (id: string) => unknown) {
  return mockApi((method, path, q) => {
    if (path === '/templates') return q.type === 'image' ? [portrait] : [ad, film]
    const m = path.match(/^\/templates\/(\w+)\/start$/)
    if (method === 'POST' && m) return start(m[1])
    if (path === '/media') return { items: [] }
  })
}

describe('templates', () => {
  it('shows cards with the placeholders highlighted', async () => {
    api(() => undefined)
    renderAt('/video/templates', routes)
    const card = (await screen.findByRole('heading', { name: '30 s product ad' })).closest('article')!
    expect(within(card).getByText('[product]').tagName).toBe('MARK')
    expect(within(card).getByText(/30s · 16:9 · Quick video/)).toBeInTheDocument()
  })

  it('opens Quick Create prefilled and waits for the user to replace the placeholders', async () => {
    const calls = api(() => ({ target: 'quick', prefill: ad.defaults }))
    renderAt('/video/templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the 30 s product ad template' }))

    const prompt = await screen.findByRole('textbox', { name: 'Describe your video' })
    expect(screen.getByTestId('location')).toHaveTextContent('/video/quick')
    expect(prompt).toHaveValue('A 30 second ad for [product] by [brand]')
    expect(screen.getByText('Template: 30 s product ad')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commercial' })).toHaveAttribute('aria-pressed', 'true')
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
    renderAt('/video/templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Short film template' }))

    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('Short film')
    expect(within(dialog).getByRole('textbox', { name: 'Brief' })).toHaveValue('A [character] must [goal] before [deadline]')
    expect(within(dialog).getByRole('radio', { name: '5 min' })).toBeChecked()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/projects')).toBe(false)
  })

  it('prefills Create Image, falling back to the template defaults if /start is missing', async () => {
    const calls = api(() => new Response('{"detail":"Not Found"}', { status: 404 }))
    renderAt('/image/templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Portrait template' }))

    expect(await screen.findByRole('textbox', { name: 'Describe the image' })).toHaveValue('Portrait of [subject], 85mm')
    expect(screen.getByTestId('location')).toHaveTextContent('/image/generate')
    expect(screen.getByRole('radio', { name: /3:4 Portrait/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: '4 images' })).toBeChecked()
    expect(screen.getByRole('button', { name: /^Create/ })).toBeDisabled()
    expect(calls.some((c) => c.path === '/images/generate')).toBe(false)
  })
})
