import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useStageShortcuts, type ShortcutMap } from './useStageShortcuts'

function Harness({ map }: { map: ShortcutMap }) {
  useStageShortcuts(map)
  return (
    <div>
      <button type="button">plain</button>
      <button type="button" data-space-play>
        take
      </button>
      <textarea aria-label="prompt" />
      <input type="number" aria-label="count" />
    </div>
  )
}

describe('useStageShortcuts', () => {
  it('fires J/K/[/]/L/digits outside fields and nothing while typing', async () => {
    const map = { j: vi.fn(), k: vi.fn(), '[': vi.fn(), ']': vi.fn(), l: vi.fn(), '3': vi.fn() }
    render(<Harness map={map} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'prompt' }))
    await user.keyboard('jkl3[[]')
    await user.click(screen.getByRole('spinbutton', { name: 'count' }))
    await user.keyboard('3')
    Object.values(map).forEach((fn) => expect(fn).not.toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: 'plain' }))
    await user.keyboard('jkl3[[]')
    Object.values(map).forEach((fn) => expect(fn).toHaveBeenCalledOnce())
  })

  it('leaves Space to a focused button unless it is a take thumbnail', async () => {
    const space = vi.fn()
    render(<Harness map={{ ' ': space }} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'plain' }))
    await user.keyboard(' ')
    expect(space).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'take' }))
    await user.keyboard(' ')
    expect(space).toHaveBeenCalledOnce()
  })
})
