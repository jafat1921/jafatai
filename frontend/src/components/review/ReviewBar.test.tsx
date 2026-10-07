import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ReviewBar, type ReviewBarProps } from './ReviewBar'
import type { GenerationStatus } from '@/lib/types'

function setup(status: GenerationStatus, extra: Partial<ReviewBarProps> = {}) {
  const handlers = {
    onApprove: vi.fn(),
    onUnapprove: vi.fn(),
    onRegenerate: vi.fn(),
    onReject: vi.fn(),
    onRestore: vi.fn(),
    onToggleVersions: vi.fn(),
    onCancel: vi.fn(),
  }
  render(<ReviewBar status={status} version={2} versionCount={4} {...handlers} {...extra} />)
  return handlers
}

const btn = (name: RegExp) => screen.queryByRole('button', { name })

describe('ReviewBar', () => {
  it('offers approve, regenerate, reject and versions when ready', async () => {
    const h = setup('ready')
    expect(btn(/^approve/i)).toBeInTheDocument()
    expect(btn(/^reject/i)).toBeInTheDocument()
    expect(btn(/^regenerate$/i)).toBeInTheDocument()
    expect(btn(/versions, showing version 2 of 4/i)).toBeInTheDocument()
    expect(btn(/unapprove/i)).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(btn(/^approve/i)!)
    await user.click(btn(/^reject/i)!)
    await user.click(btn(/^regenerate$/i)!)
    await user.click(btn(/versions/i)!)
    expect(h.onApprove).toHaveBeenCalledOnce()
    expect(h.onReject).toHaveBeenCalledOnce()
    expect(h.onRegenerate).toHaveBeenCalledWith('same')
    expect(h.onToggleVersions).toHaveBeenCalledOnce()
  })

  it('shows the locked approved badge and unapprove instead of approve/reject', async () => {
    const h = setup('approved')
    expect(screen.getByText('Approved')).toBeInTheDocument()
    expect(btn(/^approve/i)).not.toBeInTheDocument()
    expect(btn(/^reject/i)).not.toBeInTheDocument()
    await userEvent.setup().click(btn(/unapprove/i)!)
    expect(h.onUnapprove).toHaveBeenCalledOnce()
  })

  it('offers restore for rejected versions', async () => {
    const h = setup('rejected')
    expect(btn(/^approve/i)).not.toBeInTheDocument()
    await userEvent.setup().click(btn(/restore/i)!)
    expect(h.onRestore).toHaveBeenCalledOnce()
  })

  it('shows retry and the error for failed generations', async () => {
    const h = setup('failed', { error: 'Out of VRAM' })
    expect(screen.getByText('Out of VRAM')).toBeInTheDocument()
    await userEvent.setup().click(btn(/^retry$/i)!)
    expect(h.onRegenerate).toHaveBeenCalledWith('same')
  })

  it('shows progress and cancel while generating, with no review actions', async () => {
    const h = setup('generating', { progress: 0.42 })
    expect(screen.getByText('Generating 42%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(btn(/^approve/i)).not.toBeInTheDocument()
    expect(btn(/regenerate/i)).not.toBeInTheDocument()
    await userEvent.setup().click(btn(/cancel/i)!)
    expect(h.onCancel).toHaveBeenCalledOnce()
  })

  it('exposes "with note" and "edit" from the regenerate menu', async () => {
    const h = setup('ready')
    const user = userEvent.setup()
    await user.click(btn(/more regenerate options/i)!)
    await user.click(await screen.findByRole('menuitem', { name: /with note/i }))
    expect(h.onRegenerate).toHaveBeenCalledWith('note')

    await user.click(btn(/more regenerate options/i)!)
    await user.click(await screen.findByRole('menuitem', { name: /edit & regenerate/i }))
    expect(h.onRegenerate).toHaveBeenCalledWith('edit')
  })

  it('offers Upscale on finished images only', async () => {
    const onUpscale = vi.fn()
    setup('approved', { onUpscale })
    await userEvent.setup().click(btn(/^upscale/i)!)
    expect(onUpscale).toHaveBeenCalledOnce()
  })

  it('hides Upscale without a handler', () => {
    setup('ready')
    expect(btn(/^upscale/i)).not.toBeInTheDocument()
  })

  it('hides Upscale while generating', () => {
    setup('generating', { onUpscale: vi.fn() })
    expect(btn(/^upscale/i)).not.toBeInTheDocument()
  })
})
