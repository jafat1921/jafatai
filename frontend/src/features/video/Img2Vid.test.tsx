import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_I2V_FORM, i2vBlockedReason, i2vPayload } from '@/lib/video'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { CATALOG, seedCatalog } from '@/test/model-fixtures'
import { closeChip, openChip } from '@/test/dock'
import { Img2VidPage } from './Img2VidPage'
import { LengthChip } from './videoDock'

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
    const wanRadio = within(await openChip(user, 'Model')).getByRole('radio', { name: 'Wan 2.2 14B' })
    expect(wanRadio).toBeDisabled()
    expect(wanRadio).toHaveAccessibleDescription(/works from text only/)
    await closeChip(user)

    await user.click(screen.getByRole('button', { name: 'Add end image' }))
    await user.click(await screen.findByRole('button', { name: 'Pick from Library' }))
    await user.click(await screen.findByRole('button', { name: /Cup, empty/ }))
    await user.click(screen.getByRole('button', { name: /Use selected/ }))

    await user.click(screen.getByRole('textbox', { name: 'Describe the motion' }))
    await user.paste('Coffee drains from the cup, slow push in')
    const models = await openChip(user, 'Model')
    await user.click(within(models).getByRole('radio', { name: 'LTX-2.3 High quality, HQ' }))
    expect(within(models).getByText(/adds sound that fits the motion/)).toBeInTheDocument()
    await closeChip(user)
    await user.click(screen.getByRole('button', { name: /^Animate ·/ }))

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      prompt: 'Coffee drains from the cup, slow push in',
      model: 'ltx23_hq',
      duration_s: 5,
      image_id: 's1',
      end_image_id: 'end1',
    })
  })

  it('sends the camera rack and mentions, and offers 5 · 10 · 20 · 30 s · 1 min · custom with an estimate', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/mentions') return [{ type: 'character', id: 'c1', label: 'Mara', hint: 'Reef', thumb_url: null, ref_generation_id: 'g1' }]
      const id = path.match(/^\/media\/(\w+)$/)?.[1]
      if (id) return { ...media(id, { title: 'Cup, full' }), versions: [] }
      if (path === '/media') return { items: [] }
      if (method === 'POST' && path === '/videos/generate') return media('v1', { kind: 'video', media_url: null, title: 'Cup clip' })
    })
    renderAt('/video/img2vid?image=s1&model=ltx23_distilled', [{ path: '/video/img2vid', element: <Img2VidPage /> }], seedCatalog)
    const user = userEvent.setup()

    const length = await openChip(user, 'Length')
    expect(within(length).getAllByRole('button').map((b) => b.textContent)).toEqual(['5 s', '10 s', '20 s', '30 s', '1 min'])
    expect(within(length).getByText(/^Custom/)).toBeInTheDocument()
    await closeChip(user)

    const rack = await openChip(user, 'Camera')
    await user.click(within(rack).getByRole('radio', { name: 'Close-up' }))
    await user.click(within(rack).getByRole('radio', { name: 'Orbit left' }))
    await closeChip(user)
    expect(screen.getByRole('button', { name: 'Camera: CU · Orbit L slow' })).toBeInTheDocument()

    const box = screen.getByRole('textbox', { name: 'Describe the motion' })
    await user.type(box, '@ma')
    await user.click(await screen.findByRole('option', { name: /Mara/ }))
    await user.type(box, 'lifts the cup')
    expect(screen.getByText(/Video models take no reference pictures/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Animate ·/ }))

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      prompt: '@[Mara](character:c1) lifts the cup',
      model: 'ltx23_distilled',
      duration_s: 5,
      image_id: 's1',
      camera: { size: 'cu', motion: 'orbit_left', speed: 'slow' },
    })
    // the session row reads the plain name
    expect(await screen.findByRole('listitem', { name: 'Request: Mara lifts the cup' })).toBeInTheDocument()
  })

  it('puts the time it takes under the length', async () => {
    const user = userEvent.setup()
    api()
    renderAt('/', [{ path: '/', element: <LengthChip model={ltx} value={10} onChange={() => {}} estimate={{ low_s: 60, high_s: 120, basis: 'rough' }} /> }])
    await user.click(screen.getByRole('button', { name: /^Length:/ }))
    expect(await screen.findByRole('dialog', { name: 'Length' })).toHaveTextContent('10 s clip · about 1–2 min to make (rough)')
  })

  it('cannot run without a start picture', async () => {
    api()
    renderAt('/video/img2vid', [{ path: '/video/img2vid', element: <Img2VidPage /> }], seedCatalog)
    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox', { name: 'Describe the motion' }))
    await user.paste('Leaves drift past')
    expect(screen.getByRole('button', { name: /^Animate ·/ })).toBeDisabled()
    expect(screen.getByText('Add a start picture first.')).toBeInTheDocument()
  })
})
