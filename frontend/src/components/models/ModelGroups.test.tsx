import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { guessAuto, modelSections, withAuto } from '@/lib/models'
import type { ModelInfo } from '@/lib/types'
import { ModelPicker } from './ModelPicker'

const m = (x: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'label'>): ModelInfo => ({
  type: 'image',
  badge: null,
  description: '',
  capabilities: ['t2i'],
  available: true,
  installed: true,
  default: false,
  estimate_source: 'rough',
  ...x,
})

// contract v32 rows, as GET /api/models?type=image sends them
const IMAGE: ModelInfo[] = [
  m({ id: 'zimage_turbo', label: 'Z-Image Turbo', badge: 'FAST', group: 'fast', default: true, est_seconds: 7, extra: { licence: 'Apache-2.0: free for commercial use', licence_kind: 'commercial' } }),
  m({ id: 'realvis_xl5', label: 'RealVisXL V5.0', badge: 'PHOTO', group: 'photo', est_seconds: 15, extra: { licence: 'CreativeML OpenRAIL++-M', licence_kind: 'commercial' } }),
  m({ id: 'qwen_image_2512', label: 'Qwen-Image 2512', badge: 'TEXT', group: 'text', capabilities: ['t2i', 'text_render'] }),
  m({
    id: 'illustrious_xl2',
    label: 'Illustrious XL v2.0',
    badge: 'ANIME',
    group: 'anime',
    available: false,
    installed: false,
    reason: 'missing models: Illustrious-XL-v2.0.safetensors',
    extra: { licence: 'CreativeML OpenRAIL-M', licence_kind: 'commercial' },
  }),
  m({ id: 'anima', label: 'Anima', badge: 'ANIME', group: 'anime', best_for: ['anime', 'illustration'], extra: { licence: 'CircleStone Labs Non-Commercial Licence', licence_kind: 'noncommercial', noncommercial: true } }),
  m({ id: 'krea2_turbo', label: 'Krea 2', badge: '2K', group: 'experimental', extra: { licence: 'Krea 2 Community Licence: under US$1M revenue', licence_kind: 'conditional', noncommercial: true } }),
]

function Picker({ models, onPick }: { models: ModelInfo[]; onPick?: (id: string) => void }) {
  const [value, setValue] = useState(models.find((x) => x.default)?.id)
  return (
    <ModelPicker
      label="Model"
      models={models}
      value={value}
      onChange={(id) => {
        setValue(id)
        onPick?.(id)
      }}
    />
  )
}

describe('ModelPicker groups (contract v32)', () => {
  it('shows the sections in order, with Auto on top and the section in each card description', () => {
    render(<Picker models={withAuto(IMAGE, 'image').models} />)
    const group = screen.getByRole('radiogroup', { name: 'Model' })
    const headings = ['Fast', 'Photoreal', 'Text & design', 'Anime & illustration', 'Experimental']
    for (const h of headings) expect(within(group).getByText(h)).toBeInTheDocument()
    expect(within(group).queryByText(/NC/)).not.toBeInTheDocument()
    const radios = within(group).getAllByRole('radio')
    expect(radios[0]).toHaveAccessibleName('Auto')
    expect(within(group).getByRole('radio', { name: 'RealVisXL V5.0, PHOTO' })).toHaveAccessibleDescription(/Photoreal/)
    expect(group.className).toMatch(/overflow-y-auto/)
  })

  it('keeps licences out of the cards, even for NC or capped weights', () => {
    render(<Picker models={IMAGE} />)
    const anima = screen.getByRole('radio', { name: 'Anima, ANIME' })
    expect(anima).toHaveAccessibleDescription(/Best for anime, illustration/)
    expect(anima).not.toHaveAccessibleDescription(/licen|commercial/i)
    expect(within(anima).queryByText('NC')).not.toBeInTheDocument()
    const krea = screen.getByRole('radio', { name: 'Krea 2, 2K' })
    expect(within(krea).queryByText('TERMS')).not.toBeInTheDocument()
    const rv = screen.getByRole('radio', { name: 'RealVisXL V5.0, PHOTO' })
    expect(rv).not.toHaveAccessibleDescription(/OpenRAIL/)
    expect(screen.queryByText(/licen/i)).not.toBeInTheDocument()
  })

  it('marks guessed times as estimates', () => {
    render(<Picker models={IMAGE} />)
    expect(screen.getByRole('radio', { name: 'Z-Image Turbo, FAST' })).toHaveAccessibleDescription(/about 7 s each \(est\.\)/)
  })

  it('disables a model that is not installed and says so', async () => {
    const onPick = vi.fn()
    render(<Picker models={IMAGE} onPick={onPick} />)
    const ill = screen.getByRole('radio', { name: 'Illustrious XL v2.0, ANIME' })
    expect(ill).toBeDisabled()
    expect(ill).toHaveAccessibleDescription(/Not installed on the server \(missing models: Illustrious-XL-v2\.0\.safetensors\)/)
    await userEvent.setup().click(ill)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('arrow keys cross section boundaries and skip disabled cards', async () => {
    render(<Picker models={IMAGE} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Qwen-Image 2512, TEXT' }))
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: 'Anima, ANIME' })).toHaveFocus()
  })
})

describe('modelSections / guessAuto', () => {
  it('keeps an ungrouped list flat', () => {
    expect(modelSections([m({ id: 'a', label: 'A' })])).toEqual([{ id: 'all', label: null, models: [expect.objectContaining({ id: 'a' })] }])
  })

  it('guesses an installed anime model for anime prompts, and keeps text on Qwen 2512', () => {
    expect(guessAuto('image', IMAGE, { prompt: 'anime girl on a rooftop' })?.id).toBe('anima')
    expect(guessAuto('image', IMAGE, { prompt: 'anime poster that says "HI"' })?.id).toBe('qwen_image_2512')
    expect(guessAuto('image', IMAGE, { prompt: 'a misty harbour' })?.id).toBe('zimage_turbo')
    expect(guessAuto('image', IMAGE.filter((x) => x.id !== 'anima'), { prompt: 'manga panel' })?.id).toBe('zimage_turbo')
  })
})
