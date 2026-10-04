import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ShotMenu, type ShotMenuProps } from './ShotMenu'

function setup(over: Partial<ShotMenuProps> = {}) {
  const props: ShotMenuProps = {
    label: '1.2',
    canMoveUp: true,
    canMoveDown: false,
    stale: true,
    onMove: vi.fn(),
    onInsertAfter: vi.fn(),
    onRewritePrompts: vi.fn(),
    onClearStale: vi.fn(),
    onDelete: vi.fn(),
    ...over,
  }
  render(<ShotMenu {...props} />)
  return { props, user: userEvent.setup() }
}

const openMenu = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /actions for shot 1\.2/i }))

describe('ShotMenu', () => {
  it('moves, inserts, rewrites and clears stale', async () => {
    const { props, user } = setup()
    await openMenu(user)
    expect(screen.getByRole('menuitem', { name: /move down/i })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('menuitem', { name: /move up/i }))
    expect(props.onMove).toHaveBeenCalledWith(-1)

    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: /insert shot after/i }))
    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: /rewrite prompts/i }))
    await openMenu(user)
    await user.click(screen.getByRole('menuitem', { name: /clear stale/i }))
    expect(props.onInsertAfter).toHaveBeenCalledOnce()
    expect(props.onRewritePrompts).toHaveBeenCalledOnce()
    expect(props.onClearStale).toHaveBeenCalledOnce()
  })

  it('asks before deleting', async () => {
    const { props, user } = setup({ stale: false })
    await openMenu(user)
    expect(screen.queryByRole('menuitem', { name: /clear stale/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: /delete shot/i }))
    expect(props.onDelete).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: /delete shot/i }))
    expect(props.onDelete).toHaveBeenCalledOnce()
  })
})
