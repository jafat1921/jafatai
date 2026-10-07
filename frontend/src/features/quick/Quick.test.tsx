import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import { autopilotJob, mockFetch, quickProject, renderRoutes, stage, upscaleOptions, video } from '@/test/quick-fixtures'
import { closeChip, openChip } from '@/test/dock'
import { QuickCreateForm } from './QuickCreateForm'
import { QuickProgressPage } from './QuickProgressPage'

afterEach(() => vi.unstubAllGlobals())

const STAGES_RUNNING = [
  stage('outline', 'Writing', 'done', { started_at: '2026-10-07T10:00:00Z', finished_at: '2026-10-07T10:01:00Z' }),
  stage('cast', 'Cast', 'done'),
  stage('storyboard', 'Storyboard', 'done'),
  stage('render', 'Rendering', 'running'),
  stage('stitch', 'Stitching', 'pending'),
  stage('upscale', 'Upscaling', 'skipped'),
]

describe('Quick Create form', () => {
  it('sends prompt, preset length, aspect, style and toggles, then opens the progress screen', async () => {
    const calls = mockFetch((method, path) => {
      if (path === '/system/upscale-options') return upscaleOptions
      if (method === 'POST' && path === '/quick') return { project: quickProject, job: autopilotJob({ status: 'queued' }) }
    })
    renderRoutes('/create', [{ path: '/create', element: <QuickCreateForm expanded /> }])
    const user = userEvent.setup()

    await user.type(screen.getByRole('textbox', { name: 'Describe your video' }), 'A fox rescued from a storm')
    await user.click(within(await openChip(user, 'Length')).getByRole('button', { name: '2 min' }))
    await closeChip(user)
    await user.click(within(await openChip(user, 'Aspect')).getByRole('radio', { name: /9:16 Portrait/ }))
    await closeChip(user)
    await user.click(within(await openChip(user, 'Style')).getByRole('button', { name: 'Documentary' }))
    await closeChip(user)
    const sound = await openChip(user, 'Sound and finish')
    await user.click(within(sound).getByRole('switch', { name: /Dialogue/ }))
    await user.click(await within(sound).findByRole('switch', { name: /Upscale to 1080p/ }))
    await closeChip(user)
    expect(screen.getByRole('button', { name: 'Sound and finish: No narration · 1080p' })).toBeInTheDocument()
    // the whole pipeline is always a rough range
    expect(screen.getByRole('button', { name: /^Create video · 2 min film · ~\d+–\d+ min/ })).toBeEnabled()
    await user.keyboard('{Control>}{Enter}{/Control}')

    expect(calls).toContainEqual({
      method: 'POST',
      path: '/quick',
      body: {
        prompt: 'A fox rescued from a storm',
        duration_s: 120,
        aspect_ratio: '9:16',
        style: 'documentary',
        dialogue: false,
        upscale: { engine: 'fast', target: '1080p' },
      },
    })
    expect(await screen.findByTestId('location')).toHaveTextContent('/quick/q1')
  })

  it('takes a custom length and keeps upscale off when the server has no engines', async () => {
    const calls = mockFetch((method, path) => {
      if (path === '/system/upscale-options') return new Response('{"detail":"Not Found"}', { status: 404 })
      if (method === 'POST' && path === '/quick') return { project: quickProject, job: autopilotJob() }
    })
    renderRoutes('/projects', [{ path: '/projects', element: <QuickCreateForm /> }])
    const user = userEvent.setup()

    // the options sit folded in chips
    expect(screen.queryByRole('button', { name: '2 min' })).not.toBeInTheDocument()
    await user.type(within(await openChip(user, 'Length')).getByRole('textbox', { name: /custom/i }), '1:30{Enter}')
    await closeChip(user)
    const sound = await openChip(user, 'Sound and finish')
    expect(await within(sound).findByRole('switch', { name: /Upscale to 1080p/ })).toBeDisabled()
    expect(within(sound).getByText(/isn't available on this server/)).toBeInTheDocument()
    await closeChip(user)

    expect(screen.getByRole('button', { name: /Create video/ })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Describe your video' }), 'Neon city at dawn')
    await user.click(screen.getByRole('button', { name: /Create video/ }))
    const post = calls.find((c) => c.path === '/quick')!
    expect(post.body).toMatchObject({ duration_s: 90, upscale: null, style: 'cinematic', aspect_ratio: '16:9' })
  })
})

function renderProgress(jobs: ReturnType<typeof autopilotJob>[], renders: ReturnType<typeof video>[] = []) {
  const calls = mockFetch((method, path) => {
    if (path === '/jobs' && method === 'GET') return jobs
    if (path === `/projects/q1/renders`) return renders
    if (path === '/projects/q1') return quickProject
    if (path === '/system/upscale-options') return upscaleOptions
    if (method === 'POST' && path === '/jobs/j1/retry') return { ...jobs[0], status: 'queued', error: null }
  })
  const r = renderRoutes(
    '/quick/q1',
    [
      { path: '/quick/:quickId', element: <QuickProgressPage /> },
      { path: '/projects/:projectId/:stage', element: <p>studio</p> },
    ],
    (qc) => qc.setQueryData(qk.project('q1'), quickProject),
  )
  return { calls, ...r }
}

describe('Quick progress screen', () => {
  it('lays out the stage timeline with words for each state, plus detail, ETA and previews', async () => {
    const { qc } = renderProgress([
      autopilotJob({}, { stages: STAGES_RUNNING, eta_s: 720, preview_ids: ['f1', 'gone'] }),
    ])
    qc.setQueryData(qk.generation('f1'), { ...video('f1'), kind: 'keyframe_start', target_type: 'shot', media_url: '/media/f1.png', prompt: 'Fox on rocks' })

    const timeline = await screen.findByRole('list', { name: 'Progress' })
    const steps = within(timeline).getAllByRole('listitem')
    expect(steps.map((s) => s.textContent)).toEqual([
      'Step 1: WritingDone · 60 s',
      'Step 2: CastDone',
      'Step 3: StoryboardDone',
      'Step 4: RenderingIn progress',
      'Step 5: StitchingWaiting',
      'Step 6: UpscalingSkipped',
    ])
    expect(steps[3]).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('heading', { name: 'Rendering' })).toBeInTheDocument()
    expect(screen.getByText('Rendering shot 2 of 3')).toBeInTheDocument()
    expect(screen.getByText('About 12 min left')).toBeInTheDocument()
    expect(screen.getByText(/You can close this page/)).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'Start frame: Fox on rocks' })).toHaveAttribute('src', '/media/f1.png')
    expect(screen.getByRole('heading', { name: 'Lighthouse Fox' })).toHaveFocus()
  })

  it('explains a failure and retries from the failed stage', async () => {
    const stages = [...STAGES_RUNNING.slice(0, 3), stage('render', 'Rendering', 'failed', { detail: 'Shot 2 kept coming out black' }), ...STAGES_RUNNING.slice(4)]
    const { calls } = renderProgress([autopilotJob({ status: 'failed', error: 'Shot 2 kept coming out black' }, { stages })])
    const user = userEvent.setup()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Stopped at Rendering')
    expect(alert).toHaveTextContent('Shot 2 kept coming out black')
    expect(alert).toHaveTextContent(/carries on from “Rendering”/)
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(calls).toContainEqual({ method: 'POST', path: '/jobs/j1/retry', body: {} })
  })

  it('shows the finished film with download, upscale, open in studio and make another', async () => {
    renderProgress(
      [autopilotJob({ status: 'done', progress: 1 }, { stages: STAGES_RUNNING.map((s) => ({ ...s, status: 'done' as const })), final_render_id: 'r1' })],
      [video('r1')],
    )
    const user = userEvent.setup()

    expect(await screen.findByRole('heading', { name: 'Your video is ready' })).toBeInTheDocument()
    expect(screen.getByLabelText('Lighthouse Fox, Original · v1')).toHaveAttribute('src', '/media/r1.mp4')
    expect(screen.getByRole('link', { name: 'Download Lighthouse Fox' })).toHaveAttribute('href', '/api/generations/r1/download')
    expect(screen.getByRole('link', { name: /Open in Studio/ })).toHaveAttribute('href', '/projects/q1/script')
    expect(screen.getByRole('link', { name: /Make another/ })).toHaveAttribute('href', '/video/quick')

    await user.click(screen.getByRole('button', { name: 'Upscale' }))
    expect(await screen.findByRole('dialog', { name: /Upscale/ })).toBeInTheDocument()
  })
})

describe('Quick progress strips (P3)', () => {
  it('fills a mini thumbnail strip per stage and shows the ETA as a range', async () => {
    const thumb = (id: string, kind: string, video = false) => ({ id, kind, url: `/media/${id}.${video ? 'mp4' : 'png'}`, video })
    renderProgress([
      autopilotJob(
        {},
        {
          stages: STAGES_RUNNING,
          eta_s: 600,
          eta_range_s: [300, 720],
          stage_media: {
            outline: { text: '3 scenes' },
            cast: [thumb('p1', 'portrait'), thumb('l1', 'establishing')],
            storyboard: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => thumb(x, 'keyframe_end')),
            render: [thumb('t1', 'take', true)],
            stitch: [],
          },
        },
      ),
    ])
    const timeline = await screen.findByRole('list', { name: 'Progress' })
    expect(within(timeline).getByText('3 scenes')).toBeInTheDocument()
    expect(within(timeline).getByRole('list', { name: 'Cast: 2 made so far' }).querySelectorAll('img')).toHaveLength(2)
    const board = within(timeline).getByRole('list', { name: 'Storyboard: 6 made so far' })
    expect(board.querySelectorAll('img')).toHaveLength(4)
    expect(board).toHaveTextContent('+2')
    expect(within(timeline).getByRole('list', { name: 'Rendering: 1 made so far' }).querySelector('video')).toHaveAttribute('src', '/media/t1.mp4')
    expect(screen.getByText('~5–12 min left')).toBeInTheDocument()
  })

  it('"Leave — we\'ll notify you" hands the job to the jobs tray', async () => {
    const { useMyJobs } = await import('@/stores/toasts')
    renderProgress([autopilotJob({}, { stages: STAGES_RUNNING, eta_s: 720 })])
    await userEvent.setup().click(await screen.findByRole('button', { name: /leave — we.ll notify you/i }))
    expect(useMyJobs.getState().jobs.j1).toMatchObject({ label: 'Quick video: Lighthouse Fox', to: '/quick/q1' })
  })
})
