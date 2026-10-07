import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { ImageEditPage } from './ImageEditPage'
import { ImageGeneratePage } from './ImageGeneratePage'

afterEach(() => vi.unstubAllGlobals())

describe('Create Image: model choice', () => {
  it('preselects from ?model=, shows speeds and the quotes hint for Qwen-Image, and sends model + speed', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/media') return { items: [] }
      if (path === '/templates') return []
      if (method === 'POST' && path === '/images/generate') return { items: [media('n1', { media_url: null })], jobs: [job('j1')] }
    })
    renderAt('/image/generate?model=qwen_image_2512', [{ path: '/image/generate', element: <ImageGeneratePage /> }], seedCatalog)
    const user = userEvent.setup()

    expect(screen.getByRole('radio', { name: 'Qwen-Image 2512, TEXT' })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^Full: 24 steps/ })).toBeChecked()
    const prompt = screen.getByRole('textbox', { name: 'Describe the image' })
    expect(prompt).toHaveAttribute('dir', 'auto')
    expect(prompt).toHaveAccessibleDescription(/Put text in quotes, e\.g\. a poster that says "عید مبارک"/)

    await user.click(prompt)
    await user.paste('A poster that says "عید مبارک"')
    await user.click(screen.getByRole('radio', { name: /^Lightning 4-step/ }))
    await user.click(screen.getByRole('button', { name: /Create/ }))

    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/images/generate',
      body: { prompt: 'A poster that says "عید مبارک"', model: 'qwen_image_2512', speed: 'lightning4' },
    })
  })

  it('switching to a model without speeds drops the speed picker, the hint and the speed field', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/media') return { items: [] }
      if (path === '/templates') return []
      if (method === 'POST') return { items: [], jobs: [] }
    })
    renderAt('/image/generate?model=qwen_image_2512', [{ path: '/image/generate', element: <ImageGeneratePage /> }], seedCatalog)
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Z-Image Turbo, FAST' }))
    expect(screen.queryByRole('radiogroup', { name: 'Speed' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Put text in quotes/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('textbox', { name: 'Describe the image' }))
    await user.paste('a fox')
    await user.keyboard('{Control>}{Enter}{/Control}')
    const body = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>
    expect(body.model).toBe('zimage_turbo')
    expect(body).not.toHaveProperty('speed')
  })
})

describe('Edit Image: model choice', () => {
  const api = () =>
    mockApi((method, path) => {
      if (path === '/media') return { items: [] }
      const item = path.match(/^\/media\/(\w+)$/)
      if (item) return { ...media(item[1]), versions: [] }
      if (method === 'POST' && path === '/images/edit') return { items: [], jobs: [] }
    })

  it("enforces the chosen model's reference limit before sending", async () => {
    const calls = api()
    renderAt('/image/edit?sources=a,b', [{ path: '/image/edit', element: <ImageEditPage /> }], seedCatalog)
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'What should change?' }))
    await user.paste('make it night')

    await user.click(screen.getByRole('radio', { name: 'FLUX.2 klein 4B (base)' }))
    expect(screen.getByText('Source images (2/1)')).toBeInTheDocument()
    expect(screen.getByText('FLUX.2 klein 4B (base) takes 1 image. Remove 1 image or pick another model.')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: /^Edit/ })).toBeDisabled()

    await user.click(await screen.findByRole('button', { name: 'Remove Image b' }))
    await user.click(screen.getByRole('button', { name: /^Edit/ }))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/images/edit',
      body: { source_ids: ['a'], model: 'flux2_klein_edit', instruction: 'make it night' },
    })
  })

  it('defaults to Qwen-Image-Edit with up to 3 references', () => {
    api()
    renderAt('/image/edit', [{ path: '/image/edit', element: <ImageEditPage /> }], seedCatalog)
    expect(screen.getByRole('radio', { name: 'Qwen-Image-Edit 2511, BEST' })).toBeChecked()
    expect(screen.getByText('Source images (0/3)')).toBeInTheDocument()
  })
})
