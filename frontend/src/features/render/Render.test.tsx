import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Generation } from '@/lib/types'
import { qk } from '@/hooks/keys'
import { useWorkspace } from '@/stores/workspace'
import { CATALOG, seedCatalog } from '@/test/model-fixtures'
import { frame, mockApi, project, renderStage, scene, shot, PID } from '@/test/storyboard-fixtures'
import { RenderCanvas } from './RenderCanvas'

const scenes = [scene('a', 0)]
const ready = shot('s1', 'a', 0, {
  start_frame: frame('f1', 'keyframe_start', 's1', 'approved'),
  end_frame: frame('e1', 'keyframe_end', 's1', 'approved'),
  status: 'frames_ready',
})
const notReady = shot('s2', 'a', 1, { start_frame: frame('f2', 'keyframe_start', 's2', 'ready') })
const take = (id: string, version: number): Generation => ({ ...frame(id, 'take', 's1'), version, media_url: `/media/${id}.mp4` })

beforeEach(() => useWorkspace.setState({ selectedShot: {}, selectedTake: {}, selectedScene: {} }))
afterEach(() => vi.unstubAllGlobals())

describe('Render stage', () => {
  it('gates shots without an approved START behind a link to the Storyboard', () => {
    mockApi([ready, notReady])
    renderStage(<RenderCanvas />, { scenes, shots: [ready, notReady], stage: 'render' })

    const first = screen.getByRole('article', { name: 'Shot 1.1' })
    const second = screen.getByRole('article', { name: 'Shot 1.2' })
    expect(within(first).getByRole('button', { name: /render takes/i })).toBeInTheDocument()
    expect(within(second).queryByRole('button', { name: /render takes/i })).not.toBeInTheDocument()
    expect(within(second).getByRole('link', { name: /approve frames in storyboard/i })).toHaveAttribute(
      'href',
      `/projects/${PID}/storyboard`,
    )
  })

  it('renders the default number of takes for a shot', async () => {
    const calls = mockApi([ready])
    renderStage(<RenderCanvas />, { scenes, shots: [ready], stage: 'render' })
    const user = userEvent.setup()
    const count = screen.getByRole('spinbutton', { name: /takes/i })
    expect(count).toHaveValue(3)
    await user.click(screen.getByRole('button', { name: /render takes/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/5 s each/)
    expect(dialog).toHaveTextContent(/1 chunk · about/)
    await user.click(within(dialog).getByRole('button', { name: 'Render 3 takes' }))
    expect(calls).toContainEqual({ method: 'POST', path: '/shots/s1/takes', body: { count: 3 } })
  })

  it('defaults long takes to one take and warns with the multiplied estimate', async () => {
    const long = { ...ready, duration_s: 60, shot_type: 'long_take' as const }
    const calls = mockApi([long])
    renderStage(<RenderCanvas />, { scenes, shots: [long], stage: 'render' })
    const user = userEvent.setup()
    const count = screen.getByRole('spinbutton', { name: /takes/i })
    expect(count).toHaveValue(1)
    await user.tripleClick(count)
    await user.keyboard('2')
    expect(screen.getByRole('note')).toHaveTextContent('2 long takes = 2× the GPU time')

    await user.click(screen.getByRole('button', { name: /render takes/i }))
    const dialog = await screen.findByRole('alertdialog')
    // 60 s × 6 GPU-s per second × 2 takes, from the local fallback
    expect(dialog).toHaveTextContent('2 takes × 9 chunks · about 12 min on the GPU')
    expect(dialog).toHaveTextContent(/Long takes are expensive/)
    await user.click(within(dialog).getByRole('button', { name: 'Render 2 takes' }))
    expect(calls).toContainEqual({ method: 'POST', path: '/shots/s1/takes', body: { count: 2 } })
  })

  it('sends a per-request duration override', async () => {
    const calls = mockApi([ready])
    renderStage(<RenderCanvas />, { scenes, shots: [ready], stage: 'render' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /take length for shot 1\.1/i }))
    await user.click(screen.getByRole('button', { name: '30 s' }))
    await user.click(screen.getByRole('button', { name: /render takes/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('(the shot is set to 5 s)')
    await user.click(within(dialog).getByRole('button', { name: /^Render 1 take$/ }))
    expect(calls).toContainEqual({ method: 'POST', path: '/shots/s1/takes', body: { count: 1, duration_s: 30 } })
  })

  it('picks takes with number keys, oldest first, and ignores keys typed into a field', async () => {
    mockApi([ready])
    renderStage(<RenderCanvas />, {
      scenes,
      shots: [ready],
      stage: 'render',
      takes: { s1: [take('t2', 2), take('t1', 1)] },
    })
    const user = userEvent.setup()
    await user.keyboard('k')
    await user.keyboard('2')
    expect(screen.getByRole('button', { name: /^Take 2 of shot 1\.1/ })).toHaveAttribute('aria-pressed', 'true')
    expect(useWorkspace.getState().selectedTake[PID]).toBe('t2')

    await user.click(screen.getByRole('spinbutton', { name: /takes/i }))
    await user.keyboard('1')
    expect(useWorkspace.getState().selectedTake[PID]).toBe('t2')
  })

  it('Quality and Smooth motion are saved as project settings, and the confirm says what will render', async () => {
    const calls = mockApi([ready])
    renderStage(<RenderCanvas />, { scenes, shots: [ready], stage: 'render', seed: seedCatalog })
    const user = userEvent.setup()
    const quality = screen.getByRole('radiogroup', { name: 'Quality' })
    expect(within(quality).getByRole('radio', { name: 'Standard' })).toBeChecked()
    await user.click(within(quality).getByRole('radio', { name: 'High quality' }))
    expect(calls).toContainEqual({ method: 'PATCH', path: `/projects/${PID}`, body: { settings: { video_quality: 'hq' } } })
    await user.click(screen.getByRole('switch', { name: /Smooth motion/ }))
    expect(calls).toContainEqual({ method: 'PATCH', path: `/projects/${PID}`, body: { settings: { smooth_motion: true } } })

    await user.click(screen.getByRole('button', { name: /render takes/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('5 s each, high quality, smooth motion')
    await user.click(within(dialog).getByRole('button', { name: 'Render 3 takes' }))
    // the server reads quality from the project, so the body is unchanged
    expect(calls).toContainEqual({ method: 'POST', path: '/shots/s1/takes', body: { count: 3 } })
  })

  it('explains that long takes stay on Standard when the project is set to High quality', () => {
    const long = { ...ready, duration_s: 60, shot_type: 'long_take' as const }
    mockApi([long])
    renderStage(<RenderCanvas />, {
      scenes,
      shots: [long],
      stage: 'render',
      seed: (qc) => {
        seedCatalog(qc)
        qc.setQueryData(qk.project(PID), { ...project, settings: { video_quality: 'hq' } })
      },
    })
    expect(screen.getByRole('radio', { name: 'High quality' })).toBeChecked()
    expect(screen.getByRole('note')).toHaveTextContent('High quality renders single-chunk shots only, so long takes use Standard.')
  })

  it('shows High quality disabled with the reason when it is not installed, and hides the bar on an older server', () => {
    mockApi([ready])
    const missing = { ...CATALOG, video: CATALOG.video.map((m) => (m.id === 'ltx23_hq' ? { ...m, available: false, reason: 'Missing ltx-2.3-spatial-upscaler-x2-1.1' } : m)) }
    const { unmount } = renderStage(<RenderCanvas />, { scenes, shots: [ready], stage: 'render', seed: (qc) => seedCatalog(qc, missing) })
    const hq = screen.getByRole('radio', { name: 'High quality' })
    expect(hq).toBeDisabled()
    expect(hq).toHaveAccessibleDescription('Missing ltx-2.3-spatial-upscaler-x2-1.1')
    unmount()

    renderStage(<RenderCanvas />, { scenes, shots: [ready], stage: 'render' })
    expect(screen.queryByRole('radiogroup', { name: 'Quality' })).not.toBeInTheDocument()
  })
})
