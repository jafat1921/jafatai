import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import type { Package, User } from '@/lib/types'
import { PackagesPage } from './PackagesPage'

afterEach(() => vi.unstubAllGlobals())

const admin: User = { id: 'u1', email: 'admin@mixai.local', display_name: 'Admin', workspace_id: 'w1', role: 'owner', admin: true, verified: true }

const pkg = (id: string, extra: Partial<Package> = {}): Package => ({
  id, slug: null, name: id, description: '', price_pkr: 0, period: 'month', days: null, gpu_min_day: 30, gpu_min_month: null, max_queued: 2,
  private_items: false, models: null, features: {}, kind: 'standard', public: true, custom_for_user_id: null, active: true, sort: 0,
  created_at: '2026-10-17T10:00:00Z', updated_at: '2026-10-17T10:00:00Z', subscribers: 0, ...extra,
})

function open(rows: Package[], handler: (method: string, path: string, body: unknown) => unknown = () => undefined) {
  const calls = mockApi((method, path, _q, body) => {
    const hit = handler(method, path, body)
    if (hit !== undefined) return hit
    if (path === '/auth/me') return admin
    if (path === '/admin/packages') return rows
  })
  renderAt('/admin/packages', [{ path: '/admin/packages', element: <PackagesPage /> }], (qc) => qc.setQueryData(['me'], admin))
  return { calls, user: userEvent.setup() }
}

describe('Admin: Packages', () => {
  it('lists packages with price in rupees, limits and who is on them', async () => {
    open([pkg('Free', { slug: 'free', subscribers: 12, price_pkr: 0 }), pkg('Pro', { price_pkr: 2999, gpu_min_day: 240, max_queued: 6, subscribers: 3 }), pkg('Demo', { kind: 'demo', days: 7, public: false })])
    const table = await screen.findByRole('table', { name: 'Packages, 3 shown' })
    const [, free, pro, demo] = within(table).getAllByRole('row')
    expect(within(free).getByText('Everyone’s fallback')).toBeInTheDocument()
    // Free can't be archived
    expect(within(free).queryByRole('button', { name: 'Archive Free' })).toBeNull()
    expect(within(pro).getByText('Rs 2,999')).toBeInTheDocument()
    expect(within(pro).getByText('240 min')).toBeInTheDocument()
    expect(within(pro).getByText('3')).toBeInTheDocument()
    expect(within(demo).getByText('Demo · 7 days')).toBeInTheDocument()
    expect(within(demo).getByText('Clients only')).toBeInTheDocument()
  })

  it('creates a package from the form', async () => {
    const { calls, user } = open([pkg('Free', { slug: 'free' })], (method, path, body) => {
      if (method === 'POST' && path === '/admin/packages') return pkg('new', body as Partial<Package>)
    })
    await user.click(await screen.findByRole('button', { name: 'New package' }))
    const dialog = await screen.findByRole('dialog', { name: 'New package' })
    await user.type(within(dialog).getByLabelText('Name'), 'Studio')
    await user.clear(within(dialog).getByLabelText('Price (PKR)'))
    await user.type(within(dialog).getByLabelText('Price (PKR)'), '4999')
    await user.clear(within(dialog).getByLabelText('GPU min a day'))
    await user.type(within(dialog).getByLabelText('GPU min a day'), '600')
    await user.clear(within(dialog).getByLabelText('Jobs at once'))
    await user.click(within(dialog).getByLabelText('Ad Studio'))
    await user.click(within(dialog).getByRole('switch', { name: 'Show on the website' }))
    await user.click(within(dialog).getByRole('button', { name: 'Create package' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/admin/packages')).toBeDefined())
    const body = calls.find((c) => c.method === 'POST' && c.path === '/admin/packages')!.body as Record<string, unknown>
    expect(body).toMatchObject({ name: 'Studio', price_pkr: 4999, gpu_min_day: 600, max_queued: null, period: 'month', public: true, features: { ads: false }, models: null })
    expect(body).not.toHaveProperty('id')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('edits, duplicates and archives', async () => {
    const { calls, user } = open([pkg('Pro', { price_pkr: 2999 })], (method, path, body) => {
      if (method === 'PATCH' && path === '/admin/packages/Pro') return pkg('Pro', body as Partial<Package>)
      if (method === 'POST' && path === '/admin/packages/Pro/duplicate') return pkg('Pro (copy)')
      if (method === 'POST' && path === '/admin/packages/Pro/archive') return pkg('Pro', { active: false })
    })
    await user.click(await screen.findByRole('button', { name: 'Edit Pro' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Pro' })
    expect(within(dialog).getByLabelText('Price (PKR)')).toHaveValue(2999)
    await user.clear(within(dialog).getByLabelText('Price (PKR)'))
    await user.type(within(dialog).getByLabelText('Price (PKR)'), '1999')
    await user.click(within(dialog).getByRole('button', { name: 'Save package' }))
    await waitFor(() => expect((calls.find((c) => c.method === 'PATCH')?.body as Package).price_pkr).toBe(1999))

    await user.click(screen.getByRole('button', { name: 'Duplicate Pro' }))
    await user.click(screen.getByRole('button', { name: 'Archive Pro' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/admin/packages/Pro/archive')).toBe(true))
    expect(calls.some((c) => c.path === '/admin/packages/Pro/duplicate')).toBe(true)
  })
})
