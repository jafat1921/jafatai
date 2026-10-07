import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

/** Opens a prompt-dock chip ("Model: Auto ▾") and returns its popover. */
export async function openChip(user: UserEvent, name: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(`^${name}:`) }))
  return screen.findByRole('dialog', { name })
}

export const closeChip = (user: UserEvent) => user.keyboard('{Escape}')
