import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import { VerifyBanner } from '@/components/shell/VerifyBanner'
import { GenerateButton } from '@/components/generate/GenerateButton'
import { useToasts } from '@/stores/toasts'
import type { User } from '@/lib/types'
import { AccountPage } from './AccountPage'

afterEach(() => vi.unstubAllGlobals())

const me: User = { id: 'u1', email: 'nia@example.com', display_name: 'Nia', workspace_id: 'w1', role: 'owner', verified: true }

function open(user: User, handler: (method: string, path: string, body: unknown) => unknown = () => undefined, path = '/settings/account') {
  const calls = mockApi((method, p, _q, body) => {
    const hit = handler(method, p, body)
    if (hit !== undefined) return hit
    if (p === '/auth/me') return user
  })
  renderAt(
    path,
    [
      { path: '/settings/account', element: <AccountPage /> },
      { path: '/login', element: <p>sign in page</p> },
      { path: '/', element: <GenerateButton verb="Generate" estimate={null} /> },
    ],
    (qc) => qc.setQueryData(['me'], user),
    <VerifyBanner />,
  )
  return { calls, user: userEvent.setup() }
}

describe('Settings: Account', () => {
  it('saves a new name; the email is read-only', async () => {
    const { calls, user } = open(me, (method, path, body) => {
      if (method === 'PATCH' && path === '/auth/me') return { ...me, ...(body as object) }
    })
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly')
    expect(screen.getByText('Confirmed')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save name' })
    expect(save).toBeDisabled()
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Nia Khan')
    await user.click(save)
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ display_name: 'Nia Khan' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })

  it('changes the password once the two new ones match', async () => {
    const { calls, user } = open(me, (method, path) => {
      if (method === 'POST' && path === '/auth/password') return me
    })
    await user.type(screen.getByLabelText('Current password'), 'old-password-1')
    await user.type(screen.getByLabelText('New password'), 'new-password-123')
    await user.type(screen.getByLabelText('Type it again'), 'new-password-124')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(screen.getByRole('alert')).toHaveTextContent('don’t match')
    await user.clear(screen.getByLabelText('Type it again'))
    await user.type(screen.getByLabelText('Type it again'), 'new-password-123')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText(/Other browsers have been signed out/)).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/auth/password')?.body).toEqual({ current_password: 'old-password-1', new_password: 'new-password-123' })
    expect(screen.getByLabelText('Current password')).toHaveValue('')
  })

  it('shows a wrong current password', async () => {
    const { user } = open(me, (method, path) => {
      if (method === 'POST' && path === '/auth/password')
        return new Response(JSON.stringify({ detail: "Your current password isn't right" }), { status: 400 })
    })
    await user.type(screen.getByLabelText('Current password'), 'nope')
    await user.type(screen.getByLabelText('New password'), 'new-password-123')
    await user.type(screen.getByLabelText('Type it again'), 'new-password-123')
    await user.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("current password isn't right")
  })

  it('signs out everywhere after a confirm', async () => {
    const { calls, user } = open(me, (method, path) => {
      if (method === 'POST' && path === '/auth/logout-everywhere') return new Response(null, { status: 204 })
    })
    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out everywhere?' })
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))
    expect(await screen.findByText('sign in page')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/logout-everywhere')).toBe(true)
  })
})

describe('verification banner', () => {
  it('stays hidden for a confirmed user', () => {
    open(me)
    expect(screen.queryByRole('region', { name: 'Confirm your email' })).toBeNull()
  })

  it('explains, resends, and switches the generate buttons off', async () => {
    const { calls, user } = open({ ...me, verified: false }, (method, path) => {
      if (method === 'POST' && path === '/auth/verify/resend') return { detail: 'ok' }
    }, '/')
    const banner = screen.getByRole('region', { name: 'Confirm your email' })
    expect(banner).toHaveTextContent('We sent a link to nia@example.com')
    expect(screen.getByRole('button', { name: /^Generate/ })).toBeDisabled()
    expect(screen.getByText(/Confirm your email to start creating. The link is in your inbox./)).toBeInTheDocument()
    await user.click(within(banner).getByRole('button', { name: 'Send the link again' }))
    expect(await within(banner).findByText('Sent. Check your inbox.')).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/auth/verify/resend')?.body).toEqual({})
  })

  it('celebrates a freshly confirmed email and tidies the address', async () => {
    useToasts.setState({ toasts: [] })
    open(me, () => undefined, '/?verified=1')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(['Email confirmed'])
  })
})
