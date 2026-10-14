import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TemplatesPage } from '@/features/templates/TemplatesPage'
import { filterStyles, findStyle, restyleStrength } from '@/lib/styles'
import { controlFormFrom, draftFromItem, localStart, markSlot, templateBody } from '@/lib/templates'
import type { Template } from '@/lib/types'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { CATALOG, seedCatalog } from '@/test/model-fixtures'
import { closeChip, openChip } from '@/test/dock'
import { STYLE_OPTIONS } from '@/test/style-fixtures'
import type { ModelInfo, ModelType } from '@/lib/types'
import { ControlPage } from './ControlPage'
import { ImageGeneratePage } from './ImageGeneratePage'
import { Img2ImgPage } from './Img2ImgPage'

afterEach(() => vi.unstubAllGlobals())

const WITH_I2I: Record<ModelType, ModelInfo[]> = {
  ...CATALOG,
  image: CATALOG.image.map((m) => ({ ...m, capabilities: [...m.capabilities, 'i2i'] })),
}

const radios = (box: HTMLElement) => within(within(box).getByRole('radiogroup', { name: 'Style' })).getAllByRole('radio')
const names = (els: HTMLElement[]) => els.map((e) => e.getAttribute('aria-label'))

describe('style helpers', () => {
  it('filters by group and words, maps the old painterly id and presets the restyle strength', () => {
    const { styles, style_groups: groups } = STYLE_OPTIONS
    expect(filterStyles(styles, groups, 'painting', '').map((s) => s.id)).toEqual(['oil', 'watercolor'])
    expect(filterStyles(styles, groups, null, 'cel shaded').map((s) => s.id)).toEqual(['anime'])
    expect(filterStyles(styles, groups, null, '3d').map((s) => s.id)).toEqual(['clay'])  // the group's label counts
    expect(findStyle(styles, 'painterly', STYLE_OPTIONS.style_aliases)?.id).toBe('oil')
    expect(restyleStrength(findStyle(styles, 'photoreal'), groups, 0.45)).toBe(0.3)
    expect(restyleStrength(undefined, groups, 0.45)).toBe(0.45)
  })

  it('turns a selection into a [slot] and a result into a template draft', () => {
    expect(markSlot('A perfume bottle on marble', 2, 16)).toEqual({ text: 'A [perfume bottle] on marble', caret: 18 })
    expect(markSlot('A perfume', 1, 2)).toBeNull()
    const made = media('m1', { title: 'Bottle', origin: 'generated', params: { user_prompt: 'A bottle', style: 'product', aspect: '4:3', model: 'zimage_turbo' } })
    const d = draftFromItem(made)!
    expect(d).toMatchObject({ target: 'generate', prompt: 'A bottle', style: 'product', aspect: '4:3', fromMediaId: 'm1' })
    expect(templateBody({ ...d, count: 3 }, ' Bottles ', 'A [thing]', [])).toEqual({
      title: 'Bottles', target: 'generate', prompt: 'A [thing]', count: 3, model: 'zimage_turbo', aspect: '4:3', style: 'product', from_media_id: 'm1',
    })
    const edited = media('m2', { origin: 'generated', params: { instruction: 'Make it night', edit_of: [{}, {}], model: 'qwen_image_edit_2511' } })
    expect(draftFromItem(edited)).toMatchObject({ target: 'edit', prompt: 'Make it night', refLabels: ['Image 1', 'Image 2'] })
    expect(draftFromItem(media('m3', { origin: 'upload' }))).toBeNull()
    expect(draftFromItem(media('m4', { origin: 'generated', params: { user_prompt: 'x', control_of: {} } }))).toBeNull()
  })
})

describe('style gallery', () => {
  function create() {
    const calls = mockApi((method, path) => {
      if (path === '/media') return { items: [] }
      if (path === '/prompt-templates') return []
      if (path === '/images/options') return STYLE_OPTIONS
      if (method === 'POST' && path === '/images/generate') return { items: [media('n1', { media_url: null })], jobs: [job('j1', { generation_id: 'g-n1' })] }
    })
    renderAt('/image/generate', [{ path: '/image/generate', element: <ImageGeneratePage /> }], seedCatalog)
    return calls
  }

  it('narrows by group and search, and falls back to a swatch when there is no example picture', async () => {
    create()
    const user = userEvent.setup()
    const box = await openChip(user, 'Style')
    expect(names(radios(box))).toEqual([
      'None, Your words only', 'Photo, True to life', 'Cinematic, Film still', 'Product, Studio packshot', 'Oil Painting, Thick brushwork',
      'Watercolour, Soft washes', 'Anime, Cel shaded', 'Claymation, Hand-made',
    ])
    expect(within(box).getByRole('radio', { name: 'None, Your words only' })).toHaveAttribute('aria-checked', 'true')
    // no rendered example: initials on a card, never a broken image
    expect(within(within(box).getByRole('radio', { name: /^Watercolour/ })).getByTestId('style-fallback')).toHaveTextContent('WA')

    await user.click(within(box).getByRole('button', { name: 'Painting' }))
    expect(names(radios(box))).toEqual(['None, Your words only', 'Oil Painting, Thick brushwork', 'Watercolour, Soft washes'])
    await user.click(within(box).getByRole('button', { name: 'All' }))
    await user.type(within(box).getByRole('searchbox', { name: 'Search styles' }), 'cel')
    expect(names(radios(box))).toEqual(['Anime, Cel shaded'])
    expect(screen.getByText('1 style')).toBeInTheDocument()
    await user.clear(within(box).getByRole('searchbox', { name: 'Search styles' }))
    await user.type(within(box).getByRole('searchbox', { name: 'Search styles' }), 'zzz')
    expect(within(box).getByText(/No style matches/)).toBeInTheDocument()
  })

  it('is a radio grid: arrows move and pick, Home and End jump, and the chip shows the pick', async () => {
    create()
    const user = userEvent.setup()
    const box = await openChip(user, 'Style')
    const none = within(box).getByRole('radio', { name: 'None, Your words only' })
    expect(radios(box).filter((r) => r.tabIndex === 0)).toEqual([none])  // one tab stop
    none.focus()
    await user.keyboard('{ArrowRight}')
    const photo = within(box).getByRole('radio', { name: 'Photo, True to life' })
    expect(photo).toHaveAttribute('aria-checked', 'true')
    expect(photo).toHaveFocus()
    await user.keyboard('{ArrowDown}')  // four across
    expect(within(box).getByRole('radio', { name: 'Watercolour, Soft washes' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(within(box).getByRole('radio', { name: 'Claymation, Hand-made' })).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{Home}{ArrowRight}{ArrowRight}')
    expect(within(box).getByRole('radio', { name: 'Cinematic, Film still' })).toHaveFocus()
    expect(within(box).getByText(/Best on/)).toBeInTheDocument()
    await closeChip(user)
    const chip = screen.getByRole('button', { name: 'Style: Cinematic' })
    expect(chip.querySelector('img')).toHaveAttribute('src', '/api/images/styles/cinematic/preview?v=1')
  })

  it('offers the style’s best model without switching it, and sends the style id', async () => {
    const calls = create()
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Describe the image' }))
    await user.paste('A harbour at dawn')
    const box = await openChip(user, 'Style')
    await user.click(within(box).getByRole('radio', { name: 'Oil Painting, Thick brushwork' }))
    expect(screen.getByRole('button', { name: 'Model: Auto' })).toBeInTheDocument()  // not overridden
    await user.click(within(box).getByRole('button', { name: /^Use / }))
    await closeChip(user)
    expect(screen.getByRole('button', { name: /^Model: Qwen-Image/ })).toBeInTheDocument()
    await user.click(screen.getByRole('textbox', { name: 'Describe the image' }))
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ prompt: 'A harbour at dawn', style: 'oil', model: 'qwen_image_2512' })
  })
})

describe('restyle my photo', () => {
  it('a style alone is enough, and the strength starts at the style group’s preset until the user moves it', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/media') return { items: [] }
      if (path === '/images/options') return STYLE_OPTIONS
      const id = path.match(/^\/media\/(\w+)$/)?.[1]
      if (id) return { ...media(id, { title: 'Street at noon' }), versions: [] }
      if (method === 'POST' && path === '/images/img2img') return { items: [media('r1', { media_url: null })], jobs: [job('j1', { generation_id: 'g-r1' })] }
    })
    renderAt('/image/img2img?source=s1', [{ path: '/image/img2img', element: <Img2ImgPage /> }], (qc) => seedCatalog(qc, WITH_I2I))
    const user = userEvent.setup()
    expect(await screen.findByRole('img', { name: 'Street at noon' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Generate/ })).toBeDisabled()

    await user.click(within(await openChip(user, 'Style')).getByRole('radio', { name: /^Oil Painting/ }))
    await closeChip(user)
    expect(screen.getByRole('button', { name: 'Style strength: Strong 0.60' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Generate/ })).toBeEnabled()

    const box = await openChip(user, 'Style strength')
    expect(within(box).getByText(/Set for Oil Painting/)).toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: 'Balanced 0.5' }))
    await closeChip(user)
    await user.click(within(await openChip(user, 'Style')).getByRole('radio', { name: /^Photo/ }))
    await closeChip(user)
    expect(screen.getByRole('button', { name: 'Style strength: Balanced 0.50' })).toBeInTheDocument()  // kept

    await user.click(screen.getByRole('textbox', { name: 'Describe the result' }))
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/images/img2img', body: { source_id: 's1', prompt: '', style: 'photoreal', strength: 0.5 } })
  })
})

describe('save as template', () => {
  it('saves the Create Image form with a marked [slot], and from a result row', async () => {
    const old = media('old', { title: 'Bottle on marble', origin: 'generated', params: { user_prompt: 'A bottle on marble', style: 'product', aspect: '4:3' } })
    const calls = mockApi((method, path) => {
      if (path === '/media') return { items: [old] }
      if (path === '/prompt-templates') return []
      if (path === '/images/options') return STYLE_OPTIONS
      if (method === 'POST' && path === '/my-templates') return { id: 't1', type: 'image', title: 'Saved', description: '', defaults: {}, mine: true }
    })
    renderAt('/image/generate', [{ path: '/image/generate', element: <ImageGeneratePage /> }], seedCatalog)
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: 'Save this prompt as a template' })).toBeDisabled()
    await user.click(screen.getByRole('textbox', { name: 'Describe the image' }))
    await user.paste('A perfume bottle on marble')
    await user.click(screen.getByRole('button', { name: 'Save this prompt as a template' }))

    const dialog = await screen.findByRole('dialog', { name: 'Save as template' })
    const prompt = within(dialog).getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement
    prompt.setSelectionRange(2, 16)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make selection a [slot]' }))
    expect(prompt).toHaveValue('A [perfume bottle] on marble')
    expect(within(dialog).getByText('Filled in each time: [perfume bottle].')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save template' })).toBeDisabled()  // no name yet
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Perfume shot')
    await user.click(within(dialog).getByRole('button', { name: 'Save template' }))
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/my-templates')?.body).toEqual({
        title: 'Perfume shot', target: 'generate', prompt: 'A [perfume bottle] on marble', count: 2, aspect: '1:1',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save as template' })).not.toBeInTheDocument())

    const row = await screen.findByRole('listitem', { name: 'Request: Bottle on marble' })
    await user.click(within(row).getByRole('button', { name: 'Save as template' }))
    const again = await screen.findByRole('dialog', { name: 'Save as template' })
    expect(within(again).getByRole('textbox', { name: 'Prompt' })).toHaveValue('A bottle on marble')
    expect(within(again).getByText(/Keeps: Create Image · Product style · 4:3 · 1 image/)).toBeInTheDocument()
  })
})

const mine: Template = {
  id: '6b1c3f0e-0000-4000-8000-000000000001',
  type: 'image',
  target: 'image-generate',
  title: 'Perfume shot',
  description: '',
  category: 'My templates',
  mine: true,
  defaults: { prompt_scaffold: 'A [perfume bottle] on marble', aspect: '1:1', count: 2 },
}
const depth: Template = {
  id: 'image-control-depth',
  type: 'image',
  target: 'image-control',
  title: 'Depth to image',
  description: 'Keep the 3D layout of a photo.',
  category: 'Sketch, depth & pose',
  tags: ['depth'],
  examples: { scene: 'a treehouse', light: 'lamp light' },
  control: { type: 'depth', label: 'Depth', detector: 'Depth Anything V2 Small', licence: 'Apache-2.0', noncommercial: false, as_is: false },
  defaults: { prompt_scaffold: '[scene], [light]', strength: 0.85, count: 2 },
}

describe('my templates and control cards in the gallery', () => {
  it('lists My templates on their own, with rename and delete', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/prompt-templates') return [mine, depth]
      if (method === 'PATCH') return { ...mine, title: 'Perfume on stone' }
      if (method === 'DELETE') return new Response(null, { status: 204 })
    })
    renderAt('/image/prompt-templates', [{ path: '/image/prompt-templates', element: <TemplatesPage type="image" /> }])
    const user = userEvent.setup()
    const section = await screen.findByRole('region', { name: 'My templates' })
    expect(within(section).getByRole('heading', { name: 'Perfume shot' })).toBeInTheDocument()
    expect(within(section).queryByRole('heading', { name: 'Depth to image' })).not.toBeInTheDocument()
    // My templates isn't one of the category filters
    expect(screen.queryByRole('button', { name: 'My templates' })).not.toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'More for Perfume shot' }))
    await user.click(await screen.findByRole('menuitem', { name: /Rename/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename template' })
    await user.clear(within(dialog).getByRole('textbox', { name: 'Name' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Perfume on stone')
    await user.click(within(dialog).getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: `/my-templates/${mine.id}`, body: { title: 'Perfume on stone' } }))

    await user.click(within(section).getByRole('button', { name: 'More for Perfume shot' }))
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`/my-templates/${mine.id}`))
  })

  it('a control card opens Sketch, depth and pose with its prompt and strength', async () => {
    mockApi((method, path) => {
      if (path === '/prompt-templates') return [mine, depth]
      if (method === 'POST' && path.endsWith('/start')) return localStart(depth)
      if (path === '/media') return { items: [] }
      if (path === '/images/tools') return { tools: [] }
    })
    renderAt('/image/prompt-templates', [
      { path: '/image/prompt-templates', element: <TemplatesPage type="image" /> },
      { path: '/image/control', element: <ControlPage /> },
    ])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Use the Depth to image prompt template' }))
    expect(await screen.findByRole('textbox', { name: 'Describe the picture' })).toHaveValue('[scene], [light]')
    expect(screen.getByRole('radio', { name: 'Depth' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Control strength: Close 0.85' })).toBeInTheDocument()
    expect(screen.getByText('Add a photo or a depth map first.')).toBeInTheDocument()
  })
})

describe('sketch, depth and pose to image', () => {
  it('posts the control request, and says when it falls back to the looser edit model', async () => {
    expect(controlFormFrom({ control: 'pose', strength: 3, use_as_is: true })).toMatchObject({ control: 'pose', strength: 1, useAsIs: true })
    const calls = mockApi((method, path) => {
      if (path === '/media') return { items: [] }
      if (path === '/images/options') return STYLE_OPTIONS
      const id = path.match(/^\/media\/(\w+)$/)?.[1]
      if (id) return { ...media(id, { title: 'Dancer photo' }), versions: [] }
      if (path === '/images/tools')
        return {
          tools: [],
          control: {
            engine: 'Z-Image Turbo + Fun ControlNet Union 2.1', licence: 'Apache-2.0', available: false, reason: 'missing nodes: QwenImageDiffsynthControlnet',
            fallback: 'Qwen-Image-Edit', strength: { min: 0.65, max: 1, default: 0.8 },
            types: ['depth', 'canny', 'pose', 'scribble'].map((t) => ({ id: t, label: t, detector: t, licence: 'x', noncommercial: false, available: false, reason: 'missing nodes: QwenImageDiffsynthControlnet' })),
          },
        }
      if (method === 'POST' && path === '/images/control') return { items: [media('c1', { media_url: null })], jobs: [job('j1', { generation_id: 'g-c1' })], tool_fallback: 'missing nodes' }
    })
    renderAt('/image/control?type=pose&source=s1', [{ path: '/image/control', element: <ControlPage /> }])
    const user = userEvent.setup()
    expect(await screen.findByRole('img', { name: 'Dancer photo' })).toBeInTheDocument()
    expect(await screen.findByText(/Qwen-Image-Edit uses your picture as a guide/)).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Soft edges' })).not.toBeInTheDocument()  // not listed by the server
    expect(screen.getByRole('radio', { name: 'Pose' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: /Already a pose/ }))
    await user.click(screen.getByRole('textbox', { name: 'Describe the picture' }))
    await user.paste('A dancer in a red dress on a stage')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/images/control',
      body: { source_id: 's1', control: 'pose', use_as_is: true, prompt: 'A dancer in a red dress on a stage', strength: 0.8, aspect: 'source', count: 2 },
    })
  })
})
