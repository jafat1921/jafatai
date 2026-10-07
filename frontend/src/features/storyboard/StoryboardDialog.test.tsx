import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildStoryboardRequest, DEFAULT_STORYBOARD_FORM } from '@/lib/shots'
import { StoryboardDialog } from './StoryboardDialog'

function open(onSubmit = vi.fn()) {
  render(
    <StoryboardDialog
      open
      onOpenChange={() => {}}
      selectedSceneId="sc2"
      selectedSceneLabel="EXT. REEF"
      scenesWithShots={1}
      onSubmit={onSubmit}
    />,
  )
  return onSubmit
}

describe('Storyboard from script dialog', () => {
  it('defaults to first & last frame per scene for every scene, reviewing the shot list first', async () => {
    const onSubmit = open()
    expect(screen.getByRole('checkbox', { name: /generate frames now/i })).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: /storyboard all scenes/i }))
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'scene', generate_frames: true, overwrite: false, review_first: true })
  })

  it('sends shots mode, chain continuity, the selected scene and the checkbox choices', async () => {
    const onSubmit = open()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /break scenes into shots/i }))
    await user.click(screen.getByRole('switch', { name: /chain scenes/i }))
    await user.click(screen.getByRole('radio', { name: /selected scene only/i }))
    await user.click(screen.getByRole('switch', { name: /review shot list first/i }))
    await user.click(screen.getByRole('checkbox', { name: /generate frames now/i }))
    await user.click(screen.getByRole('checkbox', { name: /include scenes that already have shots/i }))
    await user.click(screen.getByRole('button', { name: /storyboard this scene/i }))
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'shots',
      generate_frames: false,
      overwrite: true,
      scene_ids: ['sc2'],
      continuity: 'chain',
    })
  })

  it('ignores the "selected" scope when no scene is selected', () => {
    expect(buildStoryboardRequest({ ...DEFAULT_STORYBOARD_FORM, scope: 'selected' })).not.toHaveProperty('scene_ids')
  })
})
