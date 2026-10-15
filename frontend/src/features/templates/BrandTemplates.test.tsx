import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrandTemplatePage } from '@/features/image/BrandTemplatePage'
import { localStart } from '@/lib/templates'
import type { BrandKit } from '@/lib/brand'
import type { Template } from '@/lib/types'
import { kit } from '@/test/brand-fixtures'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { TemplatesPage } from './TemplatesPage'

afterEach(() => vi.unstubAllGlobals())

const wrap: Template = {
  id: 'image-brand-vehicle-wrap',
  type: 'image',
  target: 'image-brand',
  title: 'Vehicle wrap',
  description: 'Your logo on a van.',
  category: 'Brand & marketing',
  tags: ['brand', 'van'],
  refs_required: 1,
  ref_labels: ['Vehicle'],
  brand_refs: ['logo'],
  surface: 'light',
  examples: { vehicle: 'white panel van' },
  options: [
    {
      slot: 'vehicle',
      label: 'Vehicle',
      choices: [
        { label: 'Panel van', value: 'white panel van' },
        { label: 'Black car', value: 'black saloon car', surface: 'dark' },
      ],
    },
  ],
  scene: { prompt_scaffold: 'A clean [vehicle] with a plain side, no logo.', aspect: '4:3' },
  defaults: { instruction_scaffold: 'Print {logo} from picture 2 on the [vehicle] in picture 1. {logo_colours}', model: 'qwen_image_edit_2511', count: 1 },
}
const portrait: Template = {
  id: 'image-portrait',
  type: 'image',
  target: 'image-generate',
  title: 'Studio portrait',
  description: 'A portrait.',
  category: 'Portraits',
  tags: ['portrait'],
  examples: { person: 'a woman' },
  defaults: { prompt_scaffold: 'Portrait of [person]', aspect: '3:4', count: 1 },
}

const ixperts = kit('k1', {
  name: 'iXperts',
  is_default: true,
  tagline: 'Clean done right',
  palette: [{ hex: '#22223B', name: 'navy' }, { hex: '#E48C84', name: 'coral' }],
  logos: { primary: { media_id: 'logo1', description: '' }, light: { media_id: 'logo2', description: '' } },
  assets: { logo1: { media_id: 'logo1', media_url: '/m/logo1.png', missing: false }, logo2: { media_id: 'logo2', media_url: '/m/logo2.png', missing: false } },
})

const routes = [
  { path: '/image/prompt-templates', element: <TemplatesPage type="image" /> },
  { path: '/image/brand', element: <BrandTemplatePage /> },
]

function api(kits: BrandKit[] = [ixperts]) {
  return mockApi((method, path) => {
    if (path === '/prompt-templates') return [portrait, wrap]
    if (path === '/brand-kits') return kits
    const m = path.match(/^\/prompt-templates\/([\w-]+)\/start$/)
    if (method === 'POST' && m) return localStart([portrait, wrap].find((t) => t.id === m[1])!)
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id), versions: [] }
    if (path === '/media') return { items: [media('p1')] }
    if (method === 'POST' && path === '/images/brand') return { items: [], jobs: [] }
  })
}

async function openWrap() {
  const user = userEvent.setup()
  renderAt('/image/prompt-templates', routes)
  await user.click(await screen.findByRole('button', { name: 'Use the Vehicle wrap prompt template' }))
  await screen.findByRole('heading', { name: 'Filled in from your brand kit' })
  return user
}

describe('brand templates', () => {
  it('the Brand & marketing chip filters the gallery, and brand cards show in both modes', async () => {
    api()
    renderAt('/image/prompt-templates', routes)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Vehicle wrap' })
    expect(screen.getByText(/Brand · your logo goes in by itself/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use the Vehicle wrap prompt template' })).toHaveTextContent('Use with my brand')

    await user.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Brand & marketing' }))
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Studio portrait' })).not.toBeInTheDocument()

    await user.click(within(screen.getByRole('group', { name: 'Generate or edit' })).getByRole('button', { name: 'Edit my photo' }))
    expect(screen.getByRole('heading', { name: 'Vehicle wrap' })).toBeInTheDocument()
  })

  it('shows the kit, fills the logo itself and needs only the photo in photo mode', async () => {
    const calls = api()
    const user = await openWrap()
    expect(screen.getByTestId('location')).toHaveTextContent('/image/brand')
    expect(screen.getByText('iXperts')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Brand colours: navy, coral' })).toBeInTheDocument()
    expect(screen.getByText(/Main logo goes in as picture 2/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Use my photo' }))
    const run = screen.getByRole('button', { name: /^Brand · 1 picture/ })
    expect(run).toBeDisabled()
    expect(screen.getByText('Add the vehicle picture first.')).toBeInTheDocument()
    // only one picture is asked for: the logo is never a slot the user fills
    expect(screen.queryByRole('button', { name: /logo/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add vehicle (required)' }))
    await user.click(await screen.findByRole('button', { name: 'Pick from Library' }))
    await user.click(await screen.findByRole('button', { name: /Image p1/ }))
    await user.click(screen.getByRole('button', { name: /Use selected/ }))
    expect(await screen.findByText('Replace [vehicle] first.')).toBeInTheDocument()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Vehicle' }), 'Panel van')
    expect(screen.getByRole('textbox', { name: 'How the logo goes on' })).toHaveValue('Print {logo} from picture 2 on the white panel van in picture 1. {logo_colours}')
    await user.click(screen.getByRole('button', { name: /^Brand · 1 picture/ }))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/images/brand')?.body).toEqual({
      template_id: 'image-brand-vehicle-wrap',
      mode: 'photo',
      brand_kit_id: 'k1',
      surface: 'light',
      instruction: 'Print {logo} from picture 2 on the white panel van in picture 1. {logo_colours}',
      count: 1,
      source_id: 'p1',
    })
  })

  it('makes the scene in one click, and a dark choice switches to the light logo', async () => {
    const calls = api()
    const user = await openWrap()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Vehicle' }), 'Black car')
    expect(screen.getByRole('textbox', { name: 'Describe the scene' })).toHaveValue('A clean black saloon car with a plain side, no logo.')
    expect(screen.getByText(/Light logo goes in as picture 2/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Make · 1 picture/ }))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/images/brand')?.body).toMatchObject({
      mode: 'scene',
      surface: 'dark',
      scene_prompt: 'A clean black saloon car with a plain side, no logo.',
      instruction: 'Print {logo} from picture 2 on the black saloon car in picture 1. {logo_colours}',
      aspect: '4:3',
    })
  })

  it('asks for a brand kit when there is none', async () => {
    api([])
    const user = userEvent.setup()
    renderAt('/image/prompt-templates', routes)
    await user.click(await screen.findByRole('button', { name: 'Use the Vehicle wrap prompt template' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('You need a brand kit with your logo first.')
    expect(within(alert).getByRole('link', { name: 'Create a brand kit' })).toHaveAttribute('href', '/brand-kits')
    expect(screen.getByRole('button', { name: /^Make · 1 picture/ })).toBeDisabled()
  })
})
