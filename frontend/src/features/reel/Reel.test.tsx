import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspace } from '@/stores/workspace'
import { renderStage, scene, shot, PID } from '@/test/storyboard-fixtures'
import { clip, mockReelApi, reelOf } from '@/test/reel-fixtures'
import { ReelCanvas } from './ReelCanvas'
import { ReelInspector } from './ReelInspector'

const scenes = [scene('a', 0), scene('b', 1)]
const shots = [
  shot('shot-x', 'a', 0, { description: 'Diver at the rail' }),
  shot('shot-y', 'a', 1, { description: 'She jumps' }),
  shot('shot-z', 'b', 0, { description: 'Under water' }),
  shot('shot-m', 'b', 1, { description: 'The reef' }),
]
const reel = reelOf([[clip('x', { shot_id: 'shot-x' }), clip('y', { shot_id: 'shot-y', changed: true })], [clip('z', { shot_id: 'shot-z' })]], 'fresh', {
  missing: [{ shot_id: 'shot-m', scene_id: 'b', reason: 'no approved take' }],
})

beforeEach(() => useWorkspace.setState({ selectedShot: {}, selectedClip: {}, selectedScene: {} }))
afterEach(() => vi.unstubAllGlobals())

describe('Reel canvas', () => {
  it('shows scenes as strips with mezzanine status, durations and changed clips', async () => {
    mockReelApi(reel)
    renderStage(<ReelCanvas />, { scenes, shots, stage: 'reel' })
    const first = await screen.findByRole('region', { name: 'SCENE A' })
    expect(within(first).getByText('Up to date')).toBeInTheDocument()
    expect(within(first).getByRole('button', { name: /^Clip 1\.2, 00:08, take changed/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('00:24')
  })

  it('changes a transition with a PATCH of just that field', async () => {
    const calls = mockReelApi(reel)
    renderStage(<ReelCanvas />, { scenes, shots, stage: 'reel' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Transition into clip 1.2: Cut. Change' }))
    await user.click(screen.getByRole('radio', { name: 'Dissolve' }))
    expect(calls).toContainEqual({ method: 'PATCH', path: '/reel-clips/y', body: { transition_in: 'dissolve' } })
    // optimistic: the chip already reads Dissolve
    expect(await screen.findByRole('button', { name: /Transition into clip 1\.2: Dissolve 0\.5 s/ })).toBeInTheDocument()

    const len = screen.getByRole('spinbutton', { name: /length/i })
    await user.clear(len)
    await user.type(len, '1.2{Enter}')
    expect(calls).toContainEqual({ method: 'PATCH', path: '/reel-clips/y', body: { transition_s: 1.2 } })
  })

  it('reorders clips within a scene from the keyboard-reachable buttons', async () => {
    const calls = mockReelApi(reel)
    renderStage(<ReelCanvas />, { scenes, shots, stage: 'reel' })
    const user = userEvent.setup()
    expect(await screen.findByRole('button', { name: 'Move clip 1.1 earlier' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Move clip 1.1 later' }))
    expect(calls).toContainEqual({ method: 'POST', path: `/projects/${PID}/reel/reorder`, body: { clip_ids: ['y', 'x', 'z'] } })
  })

  it('lists shots without an approved take with a link to Render', async () => {
    mockReelApi(reel)
    renderStage(<ReelCanvas />, { scenes, shots, stage: 'reel' })
    const user = userEvent.setup()
    const missing = await screen.findByRole('region', { name: '1 shot without an approved take' })
    const link = within(missing).getByRole('link', { name: 'Shot 2.2: open in Render' })
    expect(link).toHaveAttribute('href', `/projects/${PID}/render`)
    expect(within(missing).getByText('The reef')).toBeInTheDocument()
    await user.click(link)
    expect(useWorkspace.getState().selectedShot[PID]).toEqual({ shotId: 'shot-m', frame: 'start' })
  })
})

describe('Reel inspector', () => {
  it('validates trims (in < out ≤ source) before saving', async () => {
    const calls = mockReelApi(reel)
    useWorkspace.setState({ selectedClip: { [PID]: 'x' } })
    renderStage(<ReelInspector />, { scenes, shots, stage: 'reel' })
    const user = userEvent.setup()
    const out = await screen.findByRole('spinbutton', { name: 'Out (s)' })
    const inp = screen.getByRole('spinbutton', { name: 'In (s)' })

    await user.clear(out)
    await user.type(out, '9{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('past the end of the clip (8 s)')

    await user.clear(out)
    await user.type(out, '6')
    await user.clear(inp)
    await user.type(inp, '6.5{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('in point must be before the out point')
    // only valid pairs ever reach the server (blurring Out at 6 s saved 0–6 on the way)
    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.body)
    expect(patches).toEqual([{ trim_in_s: 0, trim_out_s: 2 }])

    await user.clear(inp)
    await user.type(inp, '1.5{Enter}')
    expect(calls).toContainEqual({ method: 'PATCH', path: '/reel-clips/x', body: { trim_in_s: 1.5, trim_out_s: 2 } })
  })

  it('leaves a clip out of the film and links back to Render', async () => {
    const calls = mockReelApi(reel)
    useWorkspace.setState({ selectedClip: { [PID]: 'x' } })
    renderStage(<ReelInspector />, { scenes, shots, stage: 'reel' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('switch', { name: /use in the film/i }))
    expect(calls).toContainEqual({ method: 'PATCH', path: '/reel-clips/x', body: { enabled: false } })
    expect(screen.getByRole('link', { name: /open in render/i })).toHaveAttribute('href', `/projects/${PID}/render`)
  })
})
