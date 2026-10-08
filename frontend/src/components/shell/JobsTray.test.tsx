import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import { notifyMine } from '@/hooks/useEventStream'
import { trackJobs } from '@/stores/toasts'
import { job, mockApi, renderAt, systemOk } from '@/test/media-fixtures'
import { Rail } from './Rail'
import { Toaster } from './Toaster'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const JOBS = [
  job('a', { type: 'image_generate', status: 'running', progress: 0.4, lane: 'image', started_at: new Date(Date.now() - 20_000).toISOString() }),
  job('b', { type: 'autopilot', status: 'queued', project_id: 'p1' }),
  job('c', { type: 'take', status: 'done', finished_at: new Date().toISOString() }),
]

function setup(jobs = JOBS) {
  mockApi((_m, p) => (p === '/system/status' ? systemOk : undefined))
  return renderAt(
    '/image/generate',
    [{ path: '/quick/:id', element: <p>quick page</p> }],
    (qc) => qc.setQueryData(qk.jobs, jobs),
    <>
      <Rail />
      <Toaster />
    </>,
  )
}

describe('background jobs tray', () => {
  it('counts what is still to do and lists it with progress, ETA and Open', async () => {
    setup()
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'Queue, 1 running, 1 waiting' })
    expect(trigger).toHaveTextContent('2')
    await user.click(trigger)

    const tray = await screen.findByRole('dialog', { name: 'Background jobs' })
    const rows = within(within(tray).getByRole('list', { name: 'Jobs' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByRole('progressbar', { name: 'Create image progress' })).toBeInTheDocument()
    expect(within(rows[0]).getByText('40%')).toBeInTheDocument()
    expect(within(rows[0]).getByText(/^~\d+(–\d+)? s left$/)).toBeInTheDocument()
    expect(within(rows[1]).getByText('In the queue')).toBeInTheDocument()
    // two-GPU servers: image/video jobs say which GPU; general (LLM, ffmpeg) jobs carry no tag
    expect(within(rows[0]).getByText('Image GPU')).toBeInTheDocument()
    expect(within(rows[1]).queryByText(/GPU$/)).toBeNull()
    expect(within(rows[1]).getByRole('link', { name: /Open/ })).toHaveAttribute('href', '/quick/p1')
    expect(within(tray).getByRole('link', { name: 'Open the queue' })).toHaveAttribute('href', '/queue')
  })
})

describe('finished toast', () => {
  it('says once when every job of my request has finished, with Open and Dismiss', async () => {
    const { qc } = setup([job('j1', { status: 'running' }), job('j2', { status: 'running' })])
    const user = userEvent.setup()
    act(() => trackJobs([{ id: 'j1' }, { id: 'j2' }], '2 images', '/image/generate'))

    const finish = (id: string) =>
      act(() => {
        const done = { ...job(id), status: 'done' as const }
        qc.setQueryData(qk.jobs, (old: ReturnType<typeof job>[]) => old.map((j) => (j.id === id ? done : j)))
        notifyMine(qc, done)
      })

    finish('j1')
    expect(screen.queryByText(/Finished/)).not.toBeInTheDocument()
    finish('j2')
    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(within(region).getByText('Finished — 2 images')).toBeInTheDocument()
    expect(region.querySelector('[aria-live="polite"]')).not.toBeNull()

    // a repeat event for the same job doesn't toast again
    finish('j2')
    expect(within(region).getAllByText('Finished — 2 images')).toHaveLength(1)

    await user.click(within(region).getByRole('button', { name: 'Dismiss' }))
    expect(within(region).queryByText('Finished — 2 images')).not.toBeInTheDocument()
  })

  it('Open goes where the job was started; failures say so', async () => {
    const { qc } = setup([job('q1', { status: 'running', type: 'autopilot', project_id: 'p1' })])
    const user = userEvent.setup()
    act(() => trackJobs([{ id: 'q1' }], '“Fox film”', '/quick/p1'))
    act(() => {
      const failed = { ...job('q1'), status: 'failed' as const, error: 'GPU out of memory' }
      qc.setQueryData(qk.jobs, [failed])
      notifyMine(qc, failed)
    })
    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(within(region).getByText('Failed — “Fox film”')).toBeInTheDocument()
    expect(within(region).getByText('GPU out of memory')).toBeInTheDocument()
    await user.click(within(region).getByRole('button', { name: 'Open' }))
    expect(screen.getByTestId('location')).toHaveTextContent('/quick/p1')
  })

  it('ignores jobs this tab did not start', () => {
    const { qc } = setup([])
    expect(notifyMine(qc, { ...job('x'), status: 'done' })).toBe(false)
    expect(within(screen.getByRole('region', { name: 'Notifications' })).queryAllByRole('listitem')).toHaveLength(0)
  })
})
