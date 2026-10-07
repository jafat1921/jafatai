import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import { useModelChoice } from '@/stores/modelChoice'
import { useWorkspace } from '@/stores/workspace'
import { seedCatalog } from '@/test/model-fixtures'
import { mockApi, project, renderStage, scene, shot, PID } from '@/test/storyboard-fixtures'
import { StoryboardCanvas } from './StoryboardCanvas'
import { StoryboardInspector } from './StoryboardInspector'

const scenes = [scene('a', 0)]
const s1 = shot('s1', 'a', 0)

beforeEach(() => {
  useWorkspace.setState({ selectedShot: {}, storyboardView: {}, selectedScene: {} })
  useModelChoice.setState({ imageModel: {} })
})
afterEach(() => vi.unstubAllGlobals())

const seed = (image_model?: string) => (qc: Parameters<typeof seedCatalog>[0]) => {
  seedCatalog(qc)
  qc.setQueryData(qk.project(PID), { ...project, settings: image_model ? { image_model } : {} })
}

describe('studio image model', () => {
  it('frames use the project default image model', async () => {
    const calls = mockApi([s1])
    renderStage(<StoryboardCanvas />, { scenes, shots: [s1], seed: seed('qwen_image_2512') })
    await userEvent.setup().click(within(screen.getByRole('article', { name: /scene 1/i })).getAllByRole('button', { name: /^generate$/i })[0])
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/generations', body: expect.objectContaining({ kind: 'keyframe_start', params: { model: 'qwen_image_2512' } }) }),
      ),
    )
  })

  it('the inspector select overrides it for this session, and the popover saves a new project default', async () => {
    const calls = mockApi([s1])
    useWorkspace.setState({ selectedShot: { [PID]: { shotId: 's1', frame: 'start' } } })
    renderStage(<StoryboardInspector />, { scenes, shots: [s1], seed: seed() })
    const user = userEvent.setup()

    const select = screen.getByRole('combobox', { name: 'Image model' })
    expect(select).toHaveValue('zimage_turbo')
    expect(within(select).getByRole('option', { name: /FLUX\.2 klein 4B .*unavailable/ })).toBeDisabled()
    await user.selectOptions(select, 'qwen_image_2512')
    await user.click(screen.getByRole('button', { name: /Generate START frame/ }))
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: '/generations', body: expect.objectContaining({ params: { model: 'qwen_image_2512' } }) })))

    await user.click(screen.getByRole('button', { name: 'Project default' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default image model' }), 'qwen_image_2512')
    await user.click(screen.getByRole('button', { name: 'Save default' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'PATCH', path: `/projects/${PID}`, body: { settings: { image_model: 'qwen_image_2512' } } }))
  })
})
