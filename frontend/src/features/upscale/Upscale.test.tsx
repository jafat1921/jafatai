import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockFetch, renderRoutes, upscaleOptions, video } from '@/test/quick-fixtures'
import type { UpscaleSegment } from '@/lib/types'
import { SegmentStrip } from './SegmentStrip'
import { UpscaleDialog } from './UpscaleDialog'

afterEach(() => vi.unstubAllGlobals())

// 768×448 source: ×4 reaches 1080p and 1440p but not 4K
const source = video('r3', { version: 3, params: { title: 'Full film', full: true, duration_s: 60, width: 768, height: 448 } })

function setup(onOpenChange = vi.fn()) {
  const calls = mockFetch((method, path) => {
    if (path === '/system/upscale-options') return upscaleOptions
    if (method === 'POST') return { id: 'ju', type: 'upscale', status: 'queued', progress: 0, message: '', attempts: 0, created_at: '' }
  })
  renderRoutes('/x', [{ path: '/x', element: <UpscaleDialog render={source} projectId="q1" onOpenChange={onOpenChange} /> }])
  return { calls, onOpenChange, user: userEvent.setup() }
}

describe('Upscale dialog', () => {
  it('shows unavailable engines disabled with the reason and preselects the default', async () => {
    setup()
    const best = await screen.findByRole('radio', { name: 'Best' })
    expect(best).toBeDisabled()
    expect(best).toHaveAccessibleDescription(/Unavailable: SeedVR2 nodes are missing/)
    expect(screen.getByRole('radio', { name: 'Fast' })).toBeChecked()
  })

  it('disables targets beyond the engine scale and previews the output size', async () => {
    setup()
    await screen.findByRole('radio', { name: 'Fast' })
    const fourK = screen.getByRole('button', { name: '4K' })
    expect(fourK).toBeDisabled()
    expect(fourK).toHaveAccessibleDescription(/Needs ×4\.8 from 768×448/)
    expect(screen.getByRole('button', { name: '1080p' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('768×448 → 3072×1792 (×4) → 1850×1080, fit to the 1920×1080 box')).toBeInTheDocument()
    expect(screen.getAllByText('About 8 min on the GPU').length).toBeGreaterThan(0)
  })

  it('upscales with the chosen engine and target on Ctrl+Enter', async () => {
    const { calls, onOpenChange, user } = setup()
    await user.click(await screen.findByRole('radio', { name: 'Quick preview' }))
    await user.click(screen.getByRole('button', { name: '1440p' }))
    expect(screen.getByText(/→ 2468×1440, fit to the 2560×1440 box/)).toBeInTheDocument()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(calls).toContainEqual({ method: 'POST', path: '/generations/r3/upscale', body: { engine: 'quick', target: '1440p' } })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('SegmentStrip', () => {
  it('draws one cell per segment and says where it is', () => {
    const segs: UpscaleSegment[] = Array.from({ length: 120 }, (_, i) => ({
      idx: i,
      t_start: i * 3.5,
      t_end: i * 3.5 + 4,
      status: i < 13 ? 'done' : i === 13 ? 'generating' : 'queued',
    }))
    renderRoutes('/x', [{ path: '/x', element: <SegmentStrip segments={segs} message="Upscaling: segment 14 of 120" /> }])
    expect(screen.getByText('Upscaling: segment 14 of 120')).toBeInTheDocument()
    const strip = screen.getByRole('img', { name: '13 of 120 segments done' })
    expect(within(strip).getAllByText('', { selector: '[data-status]' })).toHaveLength(120)
  })
})
