import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useReviewShortcuts, type ReviewShortcutHandlers } from './useReviewShortcuts'
import { isTypingTarget } from '@/lib/keyboard'

function Harness({ handlers, enabled = true }: { handlers: ReviewShortcutHandlers; enabled?: boolean }) {
  useReviewShortcuts(handlers, enabled)
  return (
    <div>
      <button type="button">focusable</button>
      <textarea aria-label="prompt" />
      <input aria-label="title" />
      <input type="checkbox" aria-label="flag" />
    </div>
  )
}

function make() {
  return {
    approve: vi.fn(),
    regenerate: vi.fn(),
    regenerateWithNote: vi.fn(),
    editAndRegenerate: vi.fn(),
    reject: vi.fn(),
    toggleVersions: vi.fn(),
  }
}

describe('useReviewShortcuts', () => {
  it('maps A / R / Shift+R / E / X / V when focus is outside text fields', async () => {
    const h = make()
    render(<Harness handlers={h} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'focusable' }))
    await user.keyboard('a')
    await user.keyboard('r')
    await user.keyboard('{Shift>}R{/Shift}')
    await user.keyboard('e')
    await user.keyboard('x')
    await user.keyboard('v')
    expect(h.approve).toHaveBeenCalledOnce()
    expect(h.regenerate).toHaveBeenCalledOnce()
    expect(h.regenerateWithNote).toHaveBeenCalledOnce()
    expect(h.editAndRegenerate).toHaveBeenCalledOnce()
    expect(h.reject).toHaveBeenCalledOnce()
    expect(h.toggleVersions).toHaveBeenCalledOnce()
  })

  it('ignores shortcuts while typing in a textarea or text input', async () => {
    const h = make()
    render(<Harness handlers={h} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'prompt' }))
    await user.keyboard('axrve')
    await user.click(screen.getByRole('textbox', { name: 'title' }))
    await user.keyboard('axrve')
    Object.values(h).forEach((fn) => expect(fn).not.toHaveBeenCalled())
    expect(screen.getByRole('textbox', { name: 'prompt' })).toHaveValue('axrve')
  })

  it('still works from a checkbox and ignores modifier combos', async () => {
    const h = make()
    render(<Harness handlers={h} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox'))
    await user.keyboard('{Control>}a{/Control}')
    expect(h.approve).not.toHaveBeenCalled()
    await user.keyboard('a')
    expect(h.approve).toHaveBeenCalledOnce()
  })

  it('does nothing when disabled or when the action is unavailable', async () => {
    const h = make()
    const { rerender } = render(<Harness handlers={h} enabled={false} />)
    const user = userEvent.setup()
    await user.keyboard('a')
    expect(h.approve).not.toHaveBeenCalled()
    rerender(<Harness handlers={{ ...h, approve: undefined }} />)
    await user.keyboard('a')
    expect(h.approve).not.toHaveBeenCalled()
  })
})

describe('isTypingTarget', () => {
  it('recognises editable elements', () => {
    const ta = document.createElement('textarea')
    const text = document.createElement('input')
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' })
    const div = document.createElement('div')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    expect(isTypingTarget(ta)).toBe(true)
    expect(isTypingTarget(text)).toBe(true)
    expect(isTypingTarget(box)).toBe(false)
    expect(isTypingTarget(div)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
