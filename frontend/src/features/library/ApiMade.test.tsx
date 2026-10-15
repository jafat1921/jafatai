import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { libraryFilter } from '@/hooks/useMedia'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import type { Job, User } from '@/lib/types'
import { QueuePage } from '@/features/queue/QueuePage'
import { LibraryPage } from './LibraryPage'

afterEach(() => vi.unstubAllGlobals())

const user = (admin: boolean): User => ({ id: 'u1', email: 'a@x', display_name: 'A', workspace_id: 'w1', role: 'owner', admin })
const job = (id: string): Job => ({ id, type: 'generate', status: 'running', progress: 0.5, message: 'Rendering', created_at: '2026-10-15T10:00:00Z' }) as Job

describe('made through the API (contract v34)', () => {
  it('adds via=api to the library query', () => {
    expect(libraryFilter('image', 'all', '', null, { apiOnly: true })).toEqual({ kind: 'image', include: 'project', via: 'api' })
    expect(libraryFilter('image', 'all', '', null, { apiOnly: false })).toEqual({ kind: 'image', include: 'project' })
  })

  it('shows the admin a filter that lists only API items', async () => {
    const calls = mockApi((_m, path, q) => {
      if (path !== '/media') return
      return q.via === 'api' ? { items: [media('api1', { title: 'From BCP' })] } : { items: [media('a', { title: 'Mine' })] }
    })
    renderAt('/image/library', [{ path: '/image/library', element: <LibraryPage kind="image" /> }], (qc) => qc.setQueryData(['me'], user(true)))
    expect(await screen.findByRole('img', { name: 'Mine' })).toBeInTheDocument()
    const chip = screen.getByRole('button', { name: 'Made through the API' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    await userEvent.setup().click(chip)
    expect(await screen.findByRole('img', { name: 'From BCP' })).toBeInTheDocument()
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(calls.at(-1)?.query).toMatchObject({ kind: 'image', via: 'api' })
  })

  it('hides the filter from everyone else', async () => {
    const calls = mockApi((_m, path) => (path === '/media' ? { items: [media('a', { title: 'Mine' })] } : undefined))
    renderAt('/image/library', [{ path: '/image/library', element: <LibraryPage kind="image" /> }], (qc) => qc.setQueryData(['me'], user(false)))
    expect(await screen.findByRole('img', { name: 'Mine' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Made through the API' })).not.toBeInTheDocument()
    expect(calls.filter((c) => c.path === '/media').every((c) => c.query.via === undefined)).toBe(true)
  })

  it('switches the queue to the API jobs for the admin', async () => {
    const calls = mockApi((_m, path, q) => (path === '/jobs' && q.via === 'api' ? [job('j-api')] : undefined))
    renderAt('/queue', [{ path: '/queue', element: <QueuePage /> }], (qc) => qc.setQueryData(['me'], user(true)))
    const chip = await screen.findByRole('button', { name: 'Made through the API' })
    await userEvent.setup().click(chip)
    await waitFor(() => expect(calls.some((c) => c.path === '/jobs' && c.query.via === 'api')).toBe(true))
    expect(await screen.findByText(/made through the API, refreshes every 10 s/)).toBeInTheDocument()
  })

  it('keeps the queue chip away from non-admins', () => {
    mockApi(() => undefined)
    renderAt('/queue', [{ path: '/queue', element: <QueuePage /> }], (qc) => qc.setQueryData(['me'], user(false)))
    expect(screen.queryByRole('button', { name: 'Made through the API' })).not.toBeInTheDocument()
  })
})
