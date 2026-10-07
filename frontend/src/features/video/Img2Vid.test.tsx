import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_I2V_FORM, i2vBlockedReason, i2vPayload } from '@/lib/video'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { CATALOG, seedCatalog } from '@/test/model-fixtures'
import { Img2VidPage } from './Img2VidPage'

afterEach(() => vi.unstubAllGlobals())

const [ltx, , wan] = CATALOG.video

function api() {
  return mockApi((method, path) => {
    if (path === '/media') return { items: [media('end1', { title: 'Cup, empty' })] }
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id, { title: id === 's1' ? 'Cup, full' : 'Cup, empty' }), versions: [] }
    if (method === 'POST' && path === '/videos/generate') return media('v1', { kind: 'video', media_url: null, title: 'Cup clip' })
  })
}

describe('image to video rules', () => {
  it('keeps text-only models out, and needs first+last frame for an end image', () => {
    expect(i2vBlockedReason(wan, false)).toMatch(/works from text only, so it can't animate a picture/)
    expect(i2vBlockedReason(ltx, true)).toBeNull()
    expect(i2vBlockedReason({ ...ltx, capabilities: ['i2v'] }, true)).toMatch(/can't land on an end image/)
  })

  it('sends start and end ids and no aspect', () => {
    expect(i2vPayload({ ...DEFAULT_I2V_FORM, startId: 'a', endId: 'b', prompt: ' pour ' }, ltx)).toEqual({
      prompt: 'pour',
      model: 'ltx23_distilled',
      duration_s: 5,
      image_id: 'a',
      end_image_id: 'b',
    })
  })
})

describe('Image to Video page', () => {
  it('animates a start picture to a picked end picture, with Wan disabled and why', async () => {
    const calls = api()
    renderAt('/video/img2vid?image=s1', [{ path: '/video/img2vid', element: <Img2VidPage /> }], seedCatalog)
    const user = userEvent.setup()

    expect(await screen.findByRole('img', { name: 'Cup, full' })).toBeInTheDocument()
    const wanRadio = screen.getByRole('radio', { name: 'Wan 2.2 14B' })
    expect(wanRadio).toBeDisabled()
    expect(wanRadio).toHaveAccessibleDescription(/works from text only/)

    await user.click(screen.getAllByRole('button', { name: 'Pick from Library' })[0])
    await user.click(await screen.findByRole('button', { name: /Cup, empty/ }))
    await user.click(screen.getByRole('button', { name: /Use selected/ }))

    await user.click(screen.getByRole('textbox', { name: 'Describe the motion' }))
    await user.paste('Coffee drains from the cup, slow push in')
    await user.click(screen.getByRole('radio', { name: 'LTX-2.3 High quality, HQ' }))
    await user.click(screen.getByRole('button', { name: /Animate/ }))

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      prompt: 'Coffee drains from the cup, slow push in',
      model: 'ltx23_hq',
      duration_s: 5,
      image_id: 's1',
      end_image_id: 'end1',
    })
    expect(screen.getByText(/adds sound that fits the motion/)).toBeInTheDocument()
  })

  it('cannot run without a start picture', async () => {
    api()
    renderAt('/video/img2vid', [{ path: '/video/img2vid', element: <Img2VidPage /> }], seedCatalog)
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Describe the motion' }))
    await user.paste('Leaves drift past')
    expect(screen.getByRole('button', { name: /Animate/ })).toBeDisabled()
    expect(screen.getByText('Add a start picture first.')).toBeInTheDocument()
  })
})
