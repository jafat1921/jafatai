import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspace } from '@/stores/workspace'
import { frame, mockApi, renderStage, scene, shot, PID } from '@/test/storyboard-fixtures'
import { StoryboardCanvas } from './StoryboardCanvas'

const scenes = [scene('a', 0), scene('b', 1)]
const s1 = shot('s1', 'a', 0, {
  start_frame: frame('f1', 'keyframe_start', 's1', 'approved'),
  end_frame: frame('e1', 'keyframe_end', 's1', 'approved'),
})
const s2 = shot('s2', 'b', 0, { seam_in: 'continue', end_frame: frame('e2', 'keyframe_end', 's2') })

beforeEach(() => {
  useWorkspace.setState({ selectedShot: {}, storyboardView: {}, selectedScene: {} })
})
afterEach(() => vi.unstubAllGlobals())

const row2 = () => screen.getByRole('article', { name: /scene 2/i })

describe('Storyboard seams', () => {
  it("shows a Continue seam's START as the previous END, linked and without a generate button", () => {
    mockApi([s1, s2])
    renderStage(<StoryboardCanvas />, { scenes, shots: [s1, s2] })

    const start = within(row2()).getByRole('button', { name: /START frame, linked to 1\.1 END/ })
    expect(within(start).getByRole('img')).toHaveAttribute('src', '/media/e1.png')
    expect(within(row2()).getAllByText(/linked/).length).toBeGreaterThan(0)
    expect(within(row2()).queryByRole('button', { name: /^generate$/i })).not.toBeInTheDocument()
  })

  it('switching the seam to Cut patches the shot and unlinks the START', async () => {
    const calls = mockApi([s1, s2])
    renderStage(<StoryboardCanvas />, { scenes, shots: [s1, s2] })
    const user = userEvent.setup()

    await user.click(within(screen.getByRole('group', { name: /seam from scene 1 to scene 2/i })).getByRole('radio', { name: /cut/i }))

    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/shots/s2', body: { seam_in: 'cut' } }))
    expect(within(row2()).getByRole('button', { name: /^START frame, empty/ })).toBeInTheDocument()
    expect(within(row2()).getByRole('button', { name: /^generate$/i })).toBeInTheDocument()
  })

  it('L toggles the seam of the selected row, but not while typing', async () => {
    const calls = mockApi([s1, s2])
    useWorkspace.setState({ storyboardView: { [PID]: 'shots' }, selectedScene: { [PID]: 'b' } })
    renderStage(<StoryboardCanvas />, { scenes, shots: [s1, s2] })
    const user = userEvent.setup()

    await user.click(screen.getByRole('textbox', { name: /description/i }))
    await user.keyboard('l')
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: /^END frame/ }))
    await user.keyboard('l')
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: '/shots/s2', body: { seam_in: 'cut' } }))
  })

  it('J/K and [ ] move the selection between rows and frames', async () => {
    mockApi([s1, s2])
    renderStage(<StoryboardCanvas />, { scenes, shots: [s1, s2] })
    const user = userEvent.setup()
    await user.keyboard('k')
    expect(useWorkspace.getState().selectedShot[PID]).toEqual({ shotId: 's1', frame: 'start' })
    await user.keyboard(']')
    expect(useWorkspace.getState().selectedShot[PID]).toEqual({ shotId: 's1', frame: 'end' })
    await user.keyboard('k')
    expect(useWorkspace.getState().selectedShot[PID]).toEqual({ shotId: 's2', frame: 'end' })
    await user.keyboard('j[[')
    expect(useWorkspace.getState().selectedShot[PID]).toEqual({ shotId: 's1', frame: 'start' })
  })

  it('leads the empty state with Storyboard from script', () => {
    mockApi([])
    renderStage(<StoryboardCanvas />, { scenes, shots: [] })
    expect(screen.getByRole('heading', { name: /storyboard your film from the script/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /storyboard from script/i }).length).toBeGreaterThan(0)
  })
})
