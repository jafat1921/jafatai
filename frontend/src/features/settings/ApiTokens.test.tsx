import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import type { ApiToken, User } from '@/lib/types'
import { ApiTokensPage } from './ApiTokensPage'
import { SettingsPage } from './SettingsPage'

afterEach(() => vi.unstubAllGlobals())

const T = '2026-10-14T10:00:00Z'

const admin: User = {
  id: 'u1', email: 'admin@mixai.local', display_name: 'Admin', workspace_id: 'w1', role: 'owner',
  api_access: true, api_docs: true,
}

const token = (id: string, extra: Partial<ApiToken> = {}): ApiToken => ({
  id, name: `Script ${id}`, prefix: 'a1b2c3d4', scopes: ['read', 'generate'], status: 'active', expires_at: '2027-01-12T10:00:00Z',
  last_used_at: null, revoked_at: null, created_at: T, ...extra,
})

function open(me: User, handler: (method: string, path: string, body: unknown) => unknown = () => undefined, list = [token('t1')]) {
  const calls = mockApi((method, path, _q, body) => {
    const hit = handler(method, path, body)
    if (hit !== undefined) return hit
    if (path === '/auth/me') return me
    if (path === '/tokens') return list
  })
  renderAt('/settings/api', [
    { path: '/settings/api', element: <ApiTokensPage /> },
    { path: '/settings', element: <p>settings home</p> },
  ], (qc) => qc.setQueryData(['me'], me))
  return { calls, user: userEvent.setup() }
}

describe('Settings: API tokens', () => {
  it('lists tokens with scopes, last use and expiry, and links to the docs', async () => {
    open(admin, () => undefined, [token('t1', { last_used_at: new Date().toISOString() }), token('t2', { status: 'revoked', scopes: ['read'] })])
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Script t1')).toBeInTheDocument()
    expect(within(rows[0]).getByText('mxa_a1b2c3d4_…')).toBeInTheDocument()
    expect(within(rows[0]).getByLabelText('Scopes')).toHaveTextContent('readgenerate')
    expect(within(rows[0]).getByText('just now')).toBeInTheDocument()
    expect(within(rows[0]).getByRole('button', { name: 'Revoke Script t1' })).toBeInTheDocument()
    // a revoked token can't be revoked again
    expect(within(rows[1]).getByText('revoked')).toBeInTheDocument()
    expect(within(rows[1]).queryByRole('button')).toBeNull()

    expect(screen.getByRole('link', { name: /Open the API docs/ })).toHaveAttribute('href', '/api/docs')
  })

  it('creates a token and shows it once', async () => {
    const secret = 'mxa_a1b2c3d4_' + 'x'.repeat(43)
    const { calls, user } = open(admin, (method, path, body) => {
      if (method === 'POST' && path === '/tokens') return { ...token('t9'), ...(body as object), token: secret }
    }, [])
    expect(await screen.findByText(/No tokens yet/)).toBeInTheDocument()
    const create = screen.getByRole('button', { name: 'Create token' })
    expect(create).toBeDisabled()

    await user.type(screen.getByLabelText('Name'), 'Nightly renders')
    await user.click(screen.getByRole('checkbox', { name: /Manage/ }))
    await user.click(screen.getByRole('checkbox', { name: /Generate/ }))
    await user.selectOptions(screen.getByLabelText('Expires after'), 'never')
    await user.click(create)

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/tokens')
      expect(post?.body).toEqual({ name: 'Nightly renders', scopes: ['read', 'manage'], expires_days: null })
    })
    const dialog = await screen.findByRole('dialog', { name: 'Copy your token now' })
    expect(within(dialog).getByLabelText('Token')).toHaveValue(secret)
    expect(within(dialog).getByText(/only time “Nightly renders” is shown/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByDisplayValue(secret)).toBeNull()
    // the list is fetched again rather than holding the response
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/tokens').length).toBeGreaterThan(1)
  })

  it('needs at least one scope', async () => {
    const { user } = open(admin)
    await user.type(await screen.findByLabelText('Name'), 'x')
    await user.click(screen.getByRole('checkbox', { name: /Read/ }))
    await user.click(screen.getByRole('checkbox', { name: /Generate/ }))
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled()
  })

  it('revokes after a confirm', async () => {
    const { calls, user } = open(admin, (method, path) => {
      if (method === 'DELETE' && path === '/tokens/t1') return new Response(null, { status: 204 })
    })
    await user.click(await screen.findByRole('button', { name: 'Revoke Script t1' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke “Script t1”?' })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await user.click(within(confirm).getByRole('button', { name: 'Revoke token' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/tokens/t1')).toBe(true))
  })

  it('shows a server refusal on create', async () => {
    const { user } = open(admin, (method, path) => {
      if (method === 'POST' && path === '/tokens') {
        return new Response(JSON.stringify({ detail: 'Viewers can only make read tokens' }), { status: 422 })
      }
    })
    await user.type(await screen.findByLabelText('Name'), 'x')
    await user.click(screen.getByRole('button', { name: 'Create token' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Viewers can only make read tokens')
  })

  it('sends anyone without API access back to Settings', async () => {
    open({ ...admin, role: 'editor', api_access: false, api_docs: false })
    expect(await screen.findByText('settings home')).toBeInTheDocument()
  })

  it('hides the docs link when the docs are closed to this user', async () => {
    open({ ...admin, api_docs: false })
    await screen.findByText('Script t1')
    expect(screen.queryByRole('link', { name: /API docs/ })).toBeNull()
  })
})

describe('Settings page: API entry', () => {
  const settings = (me: User) => {
    mockApi((_m, path) => (path === '/auth/me' ? me : undefined))
    renderAt('/settings', [{ path: '/settings', element: <SettingsPage /> }], (qc) => qc.setQueryData(['me'], me))
  }

  it('shows the API tokens link to the admin', async () => {
    settings(admin)
    expect(await screen.findByRole('link', { name: 'API tokens' })).toHaveAttribute('href', '/settings/api')
  })

  it('is hidden from everyone else', async () => {
    settings({ ...admin, role: 'editor', api_access: false })
    await screen.findByRole('heading', { name: 'Settings' })
    expect(screen.queryByRole('link', { name: 'API tokens' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'API' })).toBeNull()
  })
})
