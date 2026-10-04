import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AiAssistMenu } from './AiAssistMenu'

describe('AiAssistMenu', () => {
  it('runs a simple action from the menu', async () => {
    const onAction = vi.fn()
    render(<AiAssistMenu onAction={onAction} hasScript />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /ai assist/i }))
    await user.click(await screen.findByRole('menuitem', { name: /^expand/i }))
    expect(onAction).toHaveBeenCalledWith({ action: 'expand' })
  })

  it('asks for a tone before rewriting', async () => {
    const onAction = vi.fn()
    render(<AiAssistMenu onAction={onAction} hasScript />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /ai assist/i }))
    await user.click(await screen.findByRole('menuitem', { name: /rewrite in tone/i }))
    await user.click(await screen.findByRole('button', { name: 'Eerie' }))
    await user.click(screen.getByRole('button', { name: /^rewrite$/i }))
    expect(onAction).toHaveBeenCalledWith({ action: 'rewrite_tone', tone: 'Eerie' })
  })

  it('disables script actions on an empty scene', async () => {
    render(<AiAssistMenu onAction={vi.fn()} hasScript={false} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /ai assist/i }))
    expect(await screen.findByRole('menuitem', { name: /^tighten/i })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/write or draft the scene first/i)).toBeInTheDocument()
  })

  it('opens with Ctrl+Shift+A', async () => {
    render(<AiAssistMenu onAction={vi.fn()} hasScript />)
    await userEvent.setup().keyboard('{Control>}{Shift>}A{/Shift}{/Control}')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('shows live progress instead of the menu while working', () => {
    render(<AiAssistMenu onAction={vi.fn()} hasScript working status="Expanding the scene… 12 s" />)
    expect(screen.getByRole('status')).toHaveTextContent('Expanding the scene… 12 s')
    expect(screen.queryByRole('button', { name: /ai assist/i })).not.toBeInTheDocument()
  })
})
