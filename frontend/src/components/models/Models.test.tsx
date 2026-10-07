import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useModels } from '@/hooks/useModels'
import type { ModelInfo } from '@/lib/types'
import { mockApi } from '@/test/media-fixtures'
import { CATALOG } from '@/test/model-fixtures'
import { ModelPicker } from './ModelPicker'
import { SpeedPicker } from './SpeedPicker'

afterEach(() => vi.unstubAllGlobals())

function Picker({ models, blockedBy, onPick }: { models: ModelInfo[]; blockedBy?: (m: ModelInfo) => string | null; onPick?: (id: string) => void }) {
  const [value, setValue] = useState(models.find((m) => m.default)?.id)
  return (
    <ModelPicker
      label="Model"
      models={models}
      value={value}
      blockedBy={blockedBy}
      onChange={(id) => {
        setValue(id)
        onPick?.(id)
      }}
    />
  )
}

describe('ModelPicker', () => {
  it('shows badges, descriptions and capability labels, and selects with a click', async () => {
    const onPick = vi.fn()
    render(<Picker models={CATALOG.image} onPick={onPick} />)
    const group = screen.getByRole('radiogroup', { name: 'Model' })
    const qwen = within(group).getByRole('radio', { name: 'Qwen-Image 2512, TEXT' })
    expect(qwen).toHaveAccessibleDescription(/Text & posters, incl\. Urdu.*Text in images/)
    expect(within(group).getByRole('radio', { name: 'Z-Image Turbo, FAST' })).toBeChecked()
    expect(within(group).getByRole('radio', { name: 'Z-Image Turbo, FAST' })).toHaveAccessibleDescription(/about 7 s each/)

    await userEvent.setup().click(qwen)
    expect(onPick).toHaveBeenCalledWith('qwen_image_2512')
    expect(qwen).toBeChecked()
  })

  it('keeps unavailable models visible but disabled, with the reason', async () => {
    const onPick = vi.fn()
    render(<Picker models={CATALOG.image} onPick={onPick} />)
    const flux = screen.getByRole('radio', { name: 'FLUX.2 klein 4B, FAST' })
    expect(flux).toBeDisabled()
    expect(flux).toHaveAccessibleDescription(/Missing flux-2-klein-4b-fp8/)
    await userEvent.setup().click(flux)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('blocks a model for the current setup and says why (Wan with a start image)', () => {
    render(<Picker models={CATALOG.video} blockedBy={(m) => (m.id === 'wan22_t2v' ? 'Wan 2.2 14B works from text only.' : null)} />)
    const wan = screen.getByRole('radio', { name: 'Wan 2.2 14B' })
    expect(wan).toBeDisabled()
    expect(screen.getByText('Wan 2.2 14B works from text only.')).toBeInTheDocument()
    expect(wan).toHaveAccessibleDescription(/No sound.*Text only/)
    expect(screen.getByRole('radio', { name: 'LTX-2.3' })).toHaveAccessibleDescription(/Sound.*Long takes/)
  })

  it('moves between models with the arrow keys', async () => {
    render(<Picker models={CATALOG.edit} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Qwen-Image-Edit 2511, BEST' }))
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: 'FLUX.2 klein 4B (base)' })).toHaveFocus()
  })
})

describe('SpeedPicker', () => {
  it('lists each speed with steps and an estimate, and reports the pick', async () => {
    const qwen = CATALOG.image[1]
    const onChange = vi.fn()
    render(<SpeedPicker model={qwen} value="full" onChange={onChange} />)
    expect(screen.getByRole('radio', { name: 'Full: 24 steps · about 30 s' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Lightning 4-step: 4 steps · about 5 s' })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Turbo 2-step: 2 steps · about 3 s · roughest' }))
    expect(onChange).toHaveBeenCalledWith('turbo2')
  })

  it('renders nothing for a model without speeds', () => {
    const { container } = render(<SpeedPicker model={CATALOG.image[0]} value={undefined} onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})

function Names() {
  const { models, fallback } = useModels('image')
  return <output>{`${fallback ? 'fallback' : 'live'}: ${models.map((m) => m.label).join(', ')}`}</output>
}

const renderNames = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Names />
    </QueryClientProvider>,
  )

describe('useModels', () => {
  it('uses the catalog when the server has one', async () => {
    const calls = mockApi((_m, path) => (path === '/models' ? CATALOG.image : undefined))
    renderNames()
    expect(await screen.findByText('live: Z-Image Turbo, Qwen-Image 2512, FLUX.2 klein 4B')).toBeInTheDocument()
    expect(calls[0]).toMatchObject({ path: '/models', query: { type: 'image' } })
  })

  it('falls back to the built-in list when /models is missing (older server)', async () => {
    const calls = mockApi(() => new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 }))
    renderNames()
    expect(screen.getByText('fallback: Z-Image Turbo')).toBeInTheDocument()
    // still the fallback once the 404 has landed
    await waitFor(() => expect(calls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByText('fallback: Z-Image Turbo')).toBeInTheDocument()
  })
})
