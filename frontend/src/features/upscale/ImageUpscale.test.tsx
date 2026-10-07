import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockFetch, renderRoutes } from '@/test/quick-fixtures'
import type { Generation, ImageUpscaleOptions } from '@/lib/types'
import { ImageUpscaleDialog } from './ImageUpscaleDialog'

afterEach(() => vi.unstubAllGlobals())

const portrait: Generation = {
  id: 'p2',
  target_type: 'character',
  target_id: 'c1',
  kind: 'portrait',
  version: 2,
  status: 'approved',
  prompt: 'A diver with grey hair',
  params: {},
  seed: 1,
  media_url: '/media/p2.png',
  created_at: '2026-10-07T10:00:00Z',
}

const est = (width: number, height: number, est_gpu_s = 30, capped = false) => ({ allowed: true as const, width, height, est_gpu_s, capped })

const options: ImageUpscaleOptions = {
  media: 'image',
  engines: [
    { id: 'redraw', label: 'Redraw · Z-Image', available: true, max_long_side: 4096, multiple: 16, max_mp: 8.4,
      denoise: { min: 0.15, max: 0.5, default: 0.33 } },
    { id: 'quick', label: 'Quick · Real-ESRGAN', available: true, max_long_side: 8192, multiple: 2, max_mp: null },
    { id: 'best', label: 'Faithful · SeedVR2', available: true, max_long_side: 4096, multiple: 2, max_mp: 8.4,
      variants: ['3b', '7b'], default_variant: '3b' },
  ],
  default_engine: 'redraw',
  targets: [
    { id: '2x', label: '2×' },
    { id: '4x', label: '4×' },
    { id: '2k', label: '2K' },
    { id: '4k', label: '4K' },
  ],
  source: { width: 768, height: 1024, prompt: 'A diver with grey hair' },
  estimates: {
    redraw: { '2x': est(1536, 2048, 36), '4x': est(2496, 3344, 62, true), '2k': est(1536, 2048, 36), '4k': est(2160, 2880, 52) },
    quick: { '2x': est(1536, 2048, 5), '4x': est(3072, 4096, 11), '2k': est(1536, 2048, 5), '4k': est(2880, 3840, 10) },
    best: { '2x': est(1536, 2048, 49), '4x': est(2508, 3344, 80, true), '2k': est(1536, 2048, 49), '4k': est(2160, 2880, 67) },
  },
}

function setup(opts: ImageUpscaleOptions = options) {
  const onOpenChange = vi.fn()
  const onQueued = vi.fn()
  const calls = mockFetch((method, path) => {
    if (path === '/system/upscale-options') return opts
    if (method === 'POST') return { id: 'ju', type: 'generate', status: 'queued', progress: 0, message: '', attempts: 0, created_at: '', generation_id: 'p3' }
  })
  renderRoutes('/x', [
    { path: '/x', element: <ImageUpscaleDialog source={portrait} subject="Portrait" onOpenChange={onOpenChange} onQueued={onQueued} /> },
  ])
  return { calls, onOpenChange, onQueued, user: userEvent.setup() }
}

describe('Image upscale dialog', () => {
  it('Redraw: default engine, size preview and a detail strength slider in words', async () => {
    const { user } = setup()
    expect(await screen.findByRole('radio', { name: 'Redraw' })).toBeChecked()
    expect(screen.getByRole('button', { name: '2×' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('768×1024 → 1536×2048')).toBeInTheDocument()
    expect(screen.getByText(/About 40 s on the GPU/)).toBeInTheDocument()

    const slider = screen.getByRole('slider', { name: 'Detail strength' })
    expect(slider).toHaveValue('0.33')
    expect(slider).toHaveAttribute('aria-valuetext', 'Balanced, 0.33')
    fireEvent.change(slider, { target: { value: '0.5' } })
    expect(slider).toHaveAttribute('aria-valuetext', 'Strong, 0.50')
    fireEvent.change(slider, { target: { value: '0.15' } })
    expect(slider).toHaveAttribute('aria-valuetext', 'Subtle, 0.15')

    await user.click(screen.getByRole('button', { name: '4×' }))
    expect(screen.getByText('768×1024 → 2496×3344')).toBeInTheDocument()
    expect(screen.getByText(/held at this size to fit the GPU/)).toBeInTheDocument()
  })

  it('Redraw sends the strength; Ctrl+Enter submits and hands back the job', async () => {
    const { calls, user, onOpenChange, onQueued } = setup()
    const slider = await screen.findByRole('slider', { name: 'Detail strength' })
    fireEvent.change(slider, { target: { value: '0.3' } })
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(calls).toContainEqual({ method: 'POST', path: '/generations/p2/upscale', body: { engine: 'redraw', target: '2x', denoise: 0.3 } })
    expect(onQueued).toHaveBeenCalledWith(expect.objectContaining({ generation_id: 'p3' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Quick has no slider and sends no strength', async () => {
    const { calls, user } = setup()
    await user.click(await screen.findByRole('radio', { name: 'Quick' }))
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '4K' }))
    expect(screen.getByText('768×1024 → 2880×3840')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /upscale to 4k/i }))
    expect(calls).toContainEqual({ method: 'POST', path: '/generations/p2/upscale', body: { engine: 'quick', target: '4k' } })
  })

  it('Faithful offers the 3B / 7B toggle', async () => {
    const { calls, user } = setup()
    await user.click(await screen.findByRole('radio', { name: 'Faithful' }))
    expect(screen.getByRole('button', { name: '3B' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '7B' }))
    await user.click(screen.getByRole('button', { name: /upscale to 2×/i }))
    expect(calls).toContainEqual({ method: 'POST', path: '/generations/p2/upscale', body: { engine: 'best', target: '2x', variant: '7b' } })
  })

  it('shows an unavailable engine disabled with the reason and falls back', async () => {
    setup({
      ...options,
      engines: options.engines.map((e) => (e.id === 'redraw' ? { ...e, available: false, reason: 'missing nodes: ImageUpscaleWithModel' } : e)),
    })
    const redraw = await screen.findByRole('radio', { name: 'Redraw' })
    expect(redraw).toBeDisabled()
    expect(redraw).toHaveAccessibleDescription(/Unavailable: missing nodes: ImageUpscaleWithModel/)
    expect(screen.getByRole('radio', { name: 'Quick' })).toBeChecked()
  })

  it('disables a size the image already has', async () => {
    setup({ ...options, estimates: { ...options.estimates, redraw: { ...options.estimates.redraw, '2k': { allowed: false, reason: 'Already 2048 wide' } } } })
    await screen.findByRole('radio', { name: 'Redraw' })
    const twoK = screen.getByRole('button', { name: '2K' })
    expect(twoK).toBeDisabled()
    expect(twoK).toHaveAccessibleDescription(/Already 2048 wide/)
  })
})
