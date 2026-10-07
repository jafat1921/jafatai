import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Generation } from '@/lib/types'
import { VersionsPanel } from './VersionsPanel'
import { ZoomView } from './ZoomView'

const gen = (id: string, version: number, params: Record<string, unknown> = {}, parent_id?: string) =>
  ({
    id,
    target_type: 'character',
    target_id: 'c1',
    kind: 'portrait',
    version,
    status: 'ready',
    prompt: 'A diver',
    params,
    seed: 7,
    media_url: `/m/${id}.png`,
    created_at: '',
    parent_id,
  }) as Generation

describe('Versions panel with upscales', () => {
  it('badges the upscaled version and says which one it came from', () => {
    const versions = [
      gen('c', 3, { upscale: { target: '4k', width: 3840, height: 2160, source_id: 'b' } }, 'b'),
      gen('b', 2),
    ]
    render(
      <VersionsPanel
        versions={versions}
        currentId="c"
        showRejected={false}
        onShowRejectedChange={vi.fn()}
        onMakeCurrent={vi.fn()}
        onApprove={vi.fn()}
        onRestore={vi.fn()}
        subject="Portrait"
      />,
    )
    const [up, src] = screen.getAllByRole('listitem')
    expect(within(up).getByText('4K')).toBeInTheDocument()
    expect(within(up).getByText('Upscaled from v2')).toBeInTheDocument()
    expect(within(src).queryByText(/Upscaled/)).not.toBeInTheDocument()
    expect(within(src).getByText('seed 7')).toBeInTheDocument()
  })
})

describe('ZoomView', () => {
  it('zooms with + / − and resets with 0 when focused', async () => {
    render(<ZoomView image={{ url: '/a.png', alt: 'Portrait, version 3' }} />)
    const user = userEvent.setup()
    const view = screen.getByRole('group', { name: /Portrait, version 3/ })
    view.focus()
    await user.keyboard('+')
    expect(screen.getByRole('button', { name: /reset zoom/i })).toHaveTextContent('125%')
    await user.keyboard('+')
    expect(screen.getByRole('button', { name: /reset zoom/i })).toHaveTextContent('156%')
    await user.keyboard('-')
    expect(screen.getByRole('button', { name: /reset zoom/i })).toHaveTextContent('125%')
    await user.keyboard('0')
    expect(screen.getByRole('button', { name: /reset zoom/i })).toHaveTextContent('100%')
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeDisabled()
  })

  it('shows both versions side by side at the same zoom', async () => {
    render(
      <ZoomView
        image={{ url: '/up.png', alt: 'Upscaled', label: 'Upscaled · 4K' }}
        other={{ url: '/src.png', alt: 'Original', label: 'Original · v2' }}
        mode="side"
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /zoom in/i }))
    const imgs = screen.getAllByRole('img')
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/src.png', '/up.png'])
    expect(imgs[0].style.transform).toBe(imgs[1].style.transform)
    expect(imgs[0].style.transform).toContain('scale(1.25)')
    expect(screen.getByText('Original · v2')).toBeInTheDocument()
  })

  it('swipe mode has a keyboard-operable divider', () => {
    render(
      <ZoomView image={{ url: '/up.png', alt: 'Upscaled' }} other={{ url: '/src.png', alt: 'Original' }} mode="swipe" />,
    )
    expect(screen.getByRole('slider', { name: /swipe between/i })).toHaveValue('50')
  })
})
