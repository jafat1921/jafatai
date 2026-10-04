import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DurationFields } from './duration-picker'

function setup(value = 20, max?: number) {
  const onChange = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DurationFields value={value} onChange={onChange} max={max} />
    </QueryClientProvider>,
  )
  return { onChange, user: userEvent.setup() }
}

describe('DurationFields', () => {
  it('picks a preset and marks the current one', async () => {
    const { onChange, user } = setup(20)
    expect(screen.getByRole('button', { name: '20 s' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '2 min' }))
    expect(onChange).toHaveBeenCalledWith(120)
  })

  it('accepts typed durations like 1:15 and 2m', async () => {
    const { onChange, user } = setup(20)
    const box = screen.getByRole('textbox', { name: /custom/i })
    await user.type(box, '1:15{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(75)
    await user.clear(box)
    await user.type(box, '2m{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(120)
  })

  it('refuses values outside 1 s..max and says why', async () => {
    const { onChange, user } = setup(20)
    const box = screen.getByRole('textbox', { name: /custom/i })
    await user.type(box, '400{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Up to 5 min per take.')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    await user.clear(box)
    await user.type(box, '0{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent(/at least 1 second/i)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables presets above a lower server maximum', () => {
    setup(20, 60)
    expect(screen.getByRole('button', { name: '60 s' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '90 s' })).toBeDisabled()
    expect(screen.getByText('Custom (up to 1 min)')).toBeInTheDocument()
  })

  it('shows the estimate in plain words and flags long takes', () => {
    setup(60)
    expect(screen.getByText(/9 chunks · about 6 min on the GPU/)).toBeInTheDocument()
    expect(screen.getByText(/Long take: made in chunks/)).toBeInTheDocument()
  })
})
