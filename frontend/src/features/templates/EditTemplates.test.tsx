import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageEditPage } from '@/features/image/ImageEditPage'
import { ImageGeneratePage } from '@/features/image/ImageGeneratePage'
import { fillSlot, localStart } from '@/lib/templates'
import { placeSources } from '@/lib/images'
import type { Template } from '@/lib/types'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { TemplatesPage } from './TemplatesPage'

afterEach(() => vi.unstubAllGlobals())

const neon: Template = {
  id: 'neon',
  type: 'image',
  target: 'image-generate',
  title: 'Neon sign',
  description: 'A glowing word on a wall.',
  category: 'Typography',
  tags: ['neon'],
  examples: { WORD: 'OPEN' },
  defaults: { prompt_scaffold: 'A neon sign spelling "[WORD]"', aspect: '16:9', count: 2, model: 'qwen_image_2512' },
}
const swap: Template = {
  id: 'swap',
  type: 'image',
  target: 'image-edit',
  title: 'Outfit swap',
  description: 'Put a garment on a person.',
  category: 'Edit a photo',
  tags: ['try-on'],
  refs_required: 2,
  ref_labels: ['Person', 'Garment'],
  defaults: { instruction_scaffold: 'Dress the person in image 1 in the garment from image 2.', model: 'qwen_image_edit_2511', count: 2 },
}
const hair: Template = {
  id: 'hair',
  type: 'image',
  target: 'image-edit',
  title: 'Hairstyle and colour',
  description: 'A new cut on your own photo.',
  category: 'Edit a photo',
  tags: ['hair'],
  refs_required: 1,
  ref_labels: ['Person'],
  examples: { hairstyle: 'a bob' },
  options: [
    {
      slot: 'hairstyle',
      label: 'Hairstyle',
      choices: [
        { label: 'Pixie cut', value: 'a short pixie cut' },
        { label: 'Grid', value: 'a grid of styles', aspect: '3:4' },
      ],
    },
  ],
  defaults: { instruction_scaffold: 'Restyle the hair of the person in image 1: [hairstyle].', model: 'qwen_image_edit_2511', count: 2 },
}

const routes = [
  { path: '/image/prompt-templates', element: <TemplatesPage type="image" /> },
  { path: '/image/generate', element: <ImageGeneratePage /> },
  { path: '/image/edit', element: <ImageEditPage /> },
]

function api() {
  return mockApi((method, path) => {
    if (path === '/prompt-templates') return [neon, swap, hair]
    const m = path.match(/^\/prompt-templates\/(\w+)\/start$/)
    if (method === 'POST' && m) return localStart([neon, swap, hair].find((t) => t.id === m[1])!)
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id), versions: [] }
    if (path === '/media') return { items: [media('p1'), media('g1')] }
    if (method === 'POST' && path === '/images/edit') return { items: [], jobs: [] }
  })
}

describe('edit templates', () => {
  it('the gallery filters by generate or edit, alongside category and search', async () => {
    api()
    renderAt('/image/prompt-templates', routes)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Neon sign' })
    const modes = within(screen.getByRole('group', { name: 'Generate or edit' }))
    const cats = () => within(screen.getByRole('group', { name: 'Category' }))
    expect(cats().getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Typography', 'Edit a photo'])
    expect(screen.getByText(/Edit · needs Person \+ Garment/)).toBeInTheDocument()

    await user.click(modes.getByRole('button', { name: 'Edit my photo' }))
    expect(modes.getByRole('button', { name: 'Edit my photo' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('heading', { name: 'Neon sign' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('article')).toHaveLength(2)

    await user.type(screen.getByRole('searchbox', { name: 'Search prompt templates' }), 'garment')
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Outfit swap' })).toBeInTheDocument()

    await user.click(modes.getByRole('button', { name: 'Generate' }))
    expect(screen.getByText('Nothing matches')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    expect(screen.getAllByRole('article')).toHaveLength(3)
  })

  it('opens Edit Image with labelled slots, and only runs once both pictures are in', async () => {
    const calls = api()
    renderAt('/image/prompt-templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Outfit swap prompt template' }))

    expect(await screen.findByRole('textbox', { name: 'What should change?' })).toHaveValue('Dress the person in image 1 in the garment from image 2.')
    expect(screen.getByTestId('location')).toHaveTextContent('/image/edit')
    expect(screen.getByText('Prompt template: Outfit swap')).toBeInTheDocument()
    expect(screen.getByText('Image 1 is the person and image 2 is the garment.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Edit · 2 results/ })).toBeDisabled()
    expect(screen.getByText('Add the person and garment pictures first.')).toBeInTheDocument()

    // the garment first: it still lands in its own slot
    await user.click(screen.getByRole('button', { name: 'Add garment (required)' }))
    await user.click(await screen.findByRole('button', { name: 'Pick from Library' }))
    await user.click(await screen.findByRole('button', { name: /Image g1/ }))
    await user.click(screen.getByRole('button', { name: /Use selected/ }))
    expect(await screen.findByText('Add the person picture first.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add person (required)' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add person (required)' }))
    await user.click(await screen.findByRole('button', { name: 'Pick from Library' }))
    await user.click(await screen.findByRole('button', { name: /Image p1/ }))
    await user.click(screen.getByRole('button', { name: /Use selected/ }))

    const run = await screen.findByRole('button', { name: /^Edit · 2 results/ })
    expect(run).toBeEnabled()
    await user.click(run)
    expect(calls.find((c) => c.method === 'POST' && c.path === '/images/edit')?.body).toMatchObject({
      source_ids: ['p1', 'g1'],
      model: 'qwen_image_edit_2511',
      count: 2,
    })
  })

  it('a choice fills the [slot] and can be changed again', async () => {
    api()
    renderAt('/image/prompt-templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Hairstyle and colour prompt template' }))
    const box = await screen.findByRole('textbox', { name: 'What should change?' })
    expect(screen.getByRole('button', { name: 'Select [hairstyle] in the prompt' })).toHaveAttribute('title', 'e.g. a bob')

    const picker = screen.getByRole('combobox', { name: 'Hairstyle' })
    await user.selectOptions(picker, 'Pixie cut')
    expect(box).toHaveValue('Restyle the hair of the person in image 1: a short pixie cut.')
    await user.selectOptions(picker, 'Grid')
    expect(box).toHaveValue('Restyle the hair of the person in image 1: a grid of styles.')
    expect(screen.getByRole('button', { name: 'Aspect: 3:4' })).toBeInTheDocument()
    expect(screen.getByText('Add the person picture first.')).toBeInTheDocument()
  })

  it("generate templates still prefill Create Image, and edit ones stay out of its picker", async () => {
    api()
    renderAt('/image/prompt-templates', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Neon sign prompt template' }))
    expect(await screen.findByRole('textbox', { name: 'Describe the image' })).toHaveValue('A neon sign spelling "[WORD]"')
    expect(screen.getByTestId('location')).toHaveTextContent('/image/generate')

    await user.click(screen.getByRole('button', { name: /Start from a prompt template/ }))
    const menu = await screen.findByRole('menu')
    expect(await within(menu).findByRole('menuitem', { name: /Neon sign/ })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: /Outfit swap/ })).not.toBeInTheDocument()
  })
})

describe('slot helpers', () => {
  it('fills holes first, or the slot that was clicked', () => {
    expect(placeSources(['', 'g'], ['p'], 3).ids).toEqual(['p', 'g'])
    expect(placeSources([], ['g'], 3, 1).ids).toEqual(['', 'g'])
    expect(placeSources(['a', 'b'], ['c', 'd'], 3)).toEqual({ ids: ['a', 'b', 'c'], dropped: 1 })
  })

  it('replaces the slot, then the previous choice, and leaves rewritten text alone', () => {
    expect(fillSlot('in [era].', 'era', 'the 1920s')).toBe('in the 1920s.')
    expect(fillSlot('in the 1920s.', 'era', 'the 1950s', 'the 1920s')).toBe('in the 1950s.')
    expect(fillSlot('in my own words.', 'era', 'the 1950s', 'the 1920s')).toBe('in my own words.')
  })
})
