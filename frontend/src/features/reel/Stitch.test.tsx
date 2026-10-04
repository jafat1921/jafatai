import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspace } from '@/stores/workspace'
import { renderStage, scene, shot, PID } from '@/test/storyboard-fixtures'
import { clip, mockReelApi, reelOf } from '@/test/reel-fixtures'
import { ReelCanvas } from './ReelCanvas'

const scenes = [scene('a', 0), scene('b', 1), scene('c', 2)]
const shots = [shot('shot-x', 'a', 0), shot('shot-y', 'b', 0), shot('shot-z', 'c', 0)]
// scene C has no approved take yet
const reel = reelOf([[clip('x', { shot_id: 'shot-x' })], [clip('y', { shot_id: 'shot-y' })], []], 'fresh', {
  missing: [{ shot_id: 'shot-z', scene_id: 'c', reason: 'no approved take' }],
})
const assembleCalls = (calls: ReturnType<typeof mockReelApi>) => calls.filter((c) => c.path.endsWith('/reel/assemble')).map((c) => c.body)

beforeEach(() => useWorkspace.setState({ selectedShot: {}, selectedClip: {}, selectedScene: {} }))
afterEach(() => vi.unstubAllGlobals())

describe('Stitch panel', () => {
  it('defaults to the whole film and sends no scene_ids', async () => {
    const calls = mockReelApi(reel)
    renderStage(<ReelCanvas />, { scenes, shots, stage: 'reel' })
    const user = userEvent.setup()
    const panel = await screen.findByRole('region', { name: 'Stitch a video' })
    expect(within(panel).getByRole('combobox', { name: 'From scene' })).toHaveValue('1')
    expect(within(panel).getByRole('combobox', { name: 'To scene' })).toHaveValue('3')
    expect(within(panel).getByRole('textbox', { name: 'Name' })).toHaveValue('Full film')
    expect(within(panel).getByText('2 scenes · 00:16 · reuses 2 cached scenes')).toBeInTheDocument()
    expect(within(panel).getByText(/Scene 3\s+needs an approved take/)).toBeInTheDocument()
    // the strips inside the selection are marked
    expect(within(screen.getByRole('region', { name: 'SCENE A' })).getByText('In stitch')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'SCENE C' })).queryByText('In stitch')).toBeNull()

    await user.click(within(panel).getByRole('button', { name: /Stitch video/ }))
    expect(assembleCalls(calls)).toEqual([{ quality: 'draft' }])
  })

  it('stitches a range with Ctrl+Enter and an automatic name', async () => {
    const calls = mockReelApi(reel)
    renderStage(<ReelCanvas />, { scenes, shots, stage: 'reel' })
    const user = userEvent.setup()
    const panel = await screen.findByRole('region', { name: 'Stitch a video' })
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'From scene' }), '2')
    const name = within(panel).getByRole('textbox', { name: 'Name' })
    expect(name).toHaveValue('Scene 2')
    expect(within(screen.getByRole('region', { name: 'SCENE A' })).queryByText('In stitch')).toBeNull()

    name.focus()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(assembleCalls(calls)).toEqual([{ quality: 'draft', scene_ids: ['b'] }])
  })

  it('picks scenes by hand; scenes without takes are disabled with a way to Render', async () => {
    const calls = mockReelApi(reel)
    renderStage(<ReelCanvas />, { scenes, shots, stage: 'reel' })
    const user = userEvent.setup()
    const panel = await screen.findByRole('region', { name: 'Stitch a video' })
    await user.click(within(panel).getByRole('radio', { name: 'Pick scenes' }))

    const third = within(panel).getByRole('checkbox', { name: /Sc 3/ })
    expect(third).toBeDisabled()
    expect(within(panel).getByText('needs approved take')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Scene 3: open in Render' })).toHaveAttribute('href', `/projects/${PID}/render`)

    await user.click(within(panel).getByRole('checkbox', { name: /Sc 1/ }))
    const name = within(panel).getByRole('textbox', { name: 'Name' })
    expect(name).toHaveValue('Scene 2')
    await user.clear(name)
    await user.type(name, 'Act 2')
    await user.click(within(panel).getByRole('button', { name: /Stitch video/ }))
    expect(assembleCalls(calls)).toEqual([{ quality: 'draft', scene_ids: ['b'], title: 'Act 2' }])

    await user.click(within(panel).getByRole('button', { name: 'Clear' }))
    expect(within(panel).getByRole('button', { name: /Stitch video/ })).toBeDisabled()
    expect(within(panel).getByText('Pick at least one scene with an approved take.')).toBeInTheDocument()
  })
})
