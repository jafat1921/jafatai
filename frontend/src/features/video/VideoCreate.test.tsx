import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { closeChip, openChip } from '@/test/dock'
import { VideoCreatePage } from './VideoCreatePage'

afterEach(() => vi.unstubAllGlobals())

const route = [{ path: '/video/create', element: <VideoCreatePage /> }]

function api() {
  return mockApi((method, path, query) => {
    if (path === '/media') return { items: query.kind === 'video' ? [media('v0', { kind: 'video', title: 'Older clip', media_url: '/media/v0.mp4' })] : [] }
    const item = path.match(/^\/media\/(\w+)$/)
    if (item) return { ...media(item[1], { title: 'Harbour still' }), versions: [] }
    if (method === 'POST' && path === '/videos/generate') return media('v1', { kind: 'video', title: 'New clip', media_url: null })
    if (path === '/jobs') return [job('j1', { generation_id: 'g-v1' })]
  })
}

describe('Create Video', () => {
  it('makes a text-only Wan clip, capping the length at the model maximum', async () => {
    const calls = api()
    renderAt('/video/create', route, seedCatalog)
    const user = userEvent.setup()

    expect(screen.getByRole('button', { name: 'Model: Auto' })).toBeInTheDocument()
    await user.click(screen.getByRole('textbox', { name: 'Describe the clip' }))
    await user.paste('Gulls over a grey harbour')
    await user.click(within(await openChip(user, 'Length')).getByRole('button', { name: '10 s' }))
    await closeChip(user)
    await user.click(within(await openChip(user, 'Model')).getByRole('radio', { name: 'Wan 2.2 14B' }))
    await closeChip(user)
    // 10 s is past Wan's 5 s, so the preset is gone and the length is clamped
    const length = await openChip(user, 'Length')
    expect(within(length).queryByRole('button', { name: '10 s' })).not.toBeInTheDocument()
    expect(within(length).getByText('Custom (up to 5 s)')).toBeInTheDocument()
    await closeChip(user)
    await user.keyboard('{Control>}{Enter}{/Control}')

    expect(calls.find((c) => c.method === 'POST')).toEqual(
      expect.objectContaining({
        path: '/videos/generate',
        body: { prompt: 'Gulls over a grey harbour', model: 'wan22_t2v', duration_s: 5, aspect: '16:9' },
      }),
    )
    const results = screen.getByRole('region', { name: 'Results' })
    expect(await within(results).findByRole('listitem', { name: 'Request: Gulls over a grey harbour' })).toBeInTheDocument()
  })

  it('a start image disables Wan with the reason, and sends image_id and smooth motion with LTX', async () => {
    const calls = api()
    renderAt('/video/create?image=m1&model=ltx23_distilled', route, seedCatalog)
    const user = userEvent.setup()

    const wan = within(await openChip(user, 'Model')).getByRole('radio', { name: 'Wan 2.2 14B' })
    expect(wan).toBeDisabled()
    expect(wan).toHaveAccessibleDescription(/works from text only\. Remove the start image to use it\./)
    await closeChip(user)
    expect(await screen.findByRole('img', { name: 'Harbour still' })).toBeInTheDocument()

    await user.click(screen.getByRole('textbox', { name: 'Describe the clip' }))
    await user.paste('The boat drifts out')
    await user.click(screen.getByRole('radio', { name: 'Advanced' }))
    await user.click(screen.getByRole('switch', { name: /Smooth motion/ }))
    await user.click(screen.getByRole('button', { name: /^Render/ }))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      prompt: 'The boat drifts out',
      model: 'ltx23_distilled',
      duration_s: 5,
      aspect: '16:9',
      image_id: 'm1',
      smooth_motion: true,
    })

    // removing the image frees Wan again
    await user.click(screen.getByRole('button', { name: 'Remove the start image' }))
    expect(within(await openChip(user, 'Model')).getByRole('radio', { name: 'Wan 2.2 14B' })).toBeEnabled()
  })

  it('sets the prompt to read in either direction', () => {
    api()
    renderAt('/video/create', route, seedCatalog)
    expect(screen.getByRole('textbox', { name: 'Describe the clip' })).toHaveAttribute('dir', 'auto')
  })
})
