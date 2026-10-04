import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SuggestionCard } from './SuggestionCard'
import type { Suggestion } from '@/lib/types'

const suggestion: Suggestion = {
  id: 's1',
  project_id: 'p1',
  target_type: 'scene',
  target_id: 'sc1',
  field: 'script_text',
  current_text: 'The diver drifts over pale coral.',
  proposed_text: 'The diver drifts slowly over bleached coral.',
  action: 'expand',
  status: 'pending',
  created_at: '2026-10-04T10:00:00Z',
}

function setup(extra: Partial<React.ComponentProps<typeof SuggestionCard>> = {}) {
  const onAccept = vi.fn()
  const onReject = vi.fn()
  const { container } = render(<SuggestionCard suggestion={suggestion} onAccept={onAccept} onReject={onReject} {...extra} />)
  return { onAccept, onReject, container }
}

describe('SuggestionCard', () => {
  it('shows an inline diff of what the AI changed', () => {
    const { container } = setup()
    expect(screen.getByRole('region', { name: /ai suggestion: expand, changes the script/i })).toBeInTheDocument()
    const added = [...container.querySelectorAll('ins')].map((n) => n.textContent)
    const removed = [...container.querySelectorAll('del')].map((n) => n.textContent)
    expect(added.join(' ')).toMatch(/slowly/)
    expect(added.join(' ')).toMatch(/bleached/)
    expect(removed.join(' ')).toMatch(/pale/)
    expect(container.textContent).toContain('coral.')
  })

  it('diffs against the live text when given', () => {
    const { container } = setup({ currentText: 'The diver drifts slowly over bleached coral.' })
    expect(container.querySelectorAll('ins, del')).toHaveLength(0)
  })

  it('accepts and rejects with buttons', async () => {
    const h = setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /accept/i }))
    await user.click(screen.getByRole('button', { name: /reject/i }))
    expect(h.onAccept).toHaveBeenCalledOnce()
    expect(h.onReject).toHaveBeenCalledOnce()
  })

  it('Ctrl+Enter accepts and Esc rejects', async () => {
    const h = setup()
    const user = userEvent.setup()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(h.onAccept).toHaveBeenCalledOnce()
    await user.keyboard('{Escape}')
    expect(h.onReject).toHaveBeenCalledOnce()
  })

  it('leaves shortcuts alone when it does not own them or is busy', async () => {
    const h = setup({ shortcuts: false })
    const user = userEvent.setup()
    await user.keyboard('{Control>}{Enter}{/Control}{Escape}')
    expect(h.onAccept).not.toHaveBeenCalled()
    expect(h.onReject).not.toHaveBeenCalled()
  })
})
