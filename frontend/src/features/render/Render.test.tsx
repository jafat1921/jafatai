import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Generation } from '@/lib/types'
import { useWorkspace } from '@/stores/workspace'
import { frame, mockApi, renderStage, scene, shot, PID } from '@/test/storyboard-fixtures'
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
    expect(calls).toContainEqual({ method: 'POST', path: '/shots/s1/takes', body: { count: 3 } })
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
})
