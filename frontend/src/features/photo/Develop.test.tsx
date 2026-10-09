import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { history, jpeg, schema, stubBrowser } from '@/test/photo-fixtures'
import { PhotoStudioPage } from './PhotoStudioPage'
import { forgetPhotoSession } from './session'

beforeEach(stubBrowser)
afterEach(() => {
  forgetPhotoSession()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Extra = (method: string, path: string, body: unknown) => unknown

function setup(path = '/image/studio/g2', extra: Extra = () => undefined) {
  const calls = mockApi((method, p, _q, body) => {
    const hit = extra(method, p, body)
    if (hit !== undefined) return hit
    if (p === '/photo/schema') return schema
    if (p.endsWith('/history')) return history()
    if (p.endsWith('/preview')) return jpeg()
    if (p.endsWith('/histogram')) return { r: [], g: [], b: [], luma: [], clipped: { shadows: 0, highlights: 0 } }
    if (p.endsWith('/snapshots') && method === 'GET') return []
    if (p === '/media/m1') return { id: 'm1', title: 'Lighthouse', versions: [] }
    if (p === '/photos') return { items: [media('m1', { title: 'Lighthouse' }), media('m2', { title: 'Pier' }), media('m3', { title: 'Dunes' })], total: 3, offset: 0, next_offset: null }
    if (method === 'POST' && p.endsWith('/render')) return job('j1', { type: 'photo_render', lane: 'general', generation_id: 'g3' })
    if (p === '/looks') return []
    return undefined
  })
  renderAt(path, [{ path: '/image/studio/:generationId', element: <PhotoStudioPage /> }])
  return calls
}

const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement

describe('Develop (Lightroom layout)', { timeout: 15_000 }, () => {
  it('has the left panel, tool strip, filmstrip and view toolbar', async () => {
    setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    const left = screen.getByRole('complementary', { name: /Navigator, presets, snapshots and history/ })
    for (const name of ['Navigator', 'Presets', 'Snapshots', 'History', 'Versions']) expect(within(left).getByRole('button', { name })).toBeInTheDocument()
    expect(within(screen.getByRole('tablist', { name: 'Tools' })).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Edit', 'Crop', 'AI', 'Cut-out'])
    expect(await screen.findByRole('navigation', { name: 'Filmstrip' })).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'View' })).toBeInTheDocument()
    // the History list starts with the opened state
    expect(within(left).getByRole('list', { name: 'Edit history' })).toHaveTextContent('Opened')
  })

  it('has the D2 panels: V for black & white, colour grading wheels, grain and calibration', async () => {
    const calls = setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    fireEvent.keyDown(window, { key: 'v' })
    expect(screen.getByRole('radio', { name: 'B&W' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(window, { key: '4', code: 'Digit4', ctrlKey: true })
    expect(await screen.findByRole('slider', { name: 'Midtones hue and saturation' })).toBeInTheDocument()
    expect(slider('Blending')).toHaveValue('50')
    fireEvent.keyDown(window, { key: '6', code: 'Digit6', ctrlKey: true })
    fireEvent.change(await screen.findByRole('slider', { name: 'Grain' }), { target: { value: '40' } })
    fireEvent.keyDown(window, { key: '7', code: 'Digit7', ctrlKey: true })
    expect(await screen.findByRole('slider', { name: 'Red hue' })).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    await waitFor(() => expect(calls.find((c) => c.path === '/photo/g1/render')?.body).toMatchObject({ params: { version: 2, treatment: 'bw', grainAmount: 40 } }))
  })

  it('a panel switched off is saved as off, and comes back on', async () => {
    const calls = setup()
    const user = userEvent.setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    await user.click(screen.getByRole('button', { name: 'Turn off Basic' }))
    expect(screen.getByRole('button', { name: 'Turn on Basic' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    await waitFor(() => expect(calls.find((c) => c.path === '/photo/g1/render')?.body).toMatchObject({ params: { version: 2, exposure: 0.3, contrast: 10, off: ['basic'] } }))
  })

  it('copies settings by group and pastes them back', async () => {
    setup()
    const user = userEvent.setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    await user.click(screen.getByRole('button', { name: /Copy settings/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Copy settings' })
    await user.click(within(dialog).getByRole('button', { name: 'Check none' }))
    await user.click(within(dialog).getByRole('checkbox', { name: /Basic/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }))
    fireEvent.change(slider('Exposure'), { target: { value: '-0.5' } })
    expect(slider('Exposure')).toHaveValue('-0.5')
    await user.click(screen.getByRole('button', { name: /Paste settings/ }))
    expect(slider('Exposure')).toHaveValue('0.3')
  })

  it('Ctrl+3 opens the colour mixer and closes the rest; the history list jumps back', async () => {
    setup()
    const user = userEvent.setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', ctrlKey: true })
    await waitFor(() => expect(screen.queryByRole('slider', { name: 'Exposure' })).not.toBeInTheDocument())
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', ctrlKey: true })
    fireEvent.change(await screen.findByRole('slider', { name: 'Exposure' }), { target: { value: '0.45' } })
    const hist = screen.getByRole('list', { name: 'Edit history' })
    expect(within(hist).getByRole('button', { name: 'Exposure +0.45 EV' })).toHaveAttribute('aria-current', 'step')
    await user.click(within(hist).getByRole('button', { name: 'Opened' }))
    expect(slider('Exposure')).toHaveValue('0.3')
  })

  it('saves a named snapshot of the current settings', async () => {
    const calls = setup('/image/studio/g2', (m, p) => (m === 'POST' && p === '/photo/g1/snapshots' ? { id: 's1', name: 'Warm', base_id: 'g1', params: {}, created_at: '', updated_at: '' } : undefined))
    const user = userEvent.setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    await user.click(screen.getByRole('button', { name: /New snapshot/ }))
    const name = await screen.findByRole('textbox', { name: 'Snapshot name' })
    await user.clear(name)
    await user.type(name, 'Warm{Enter}')
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/photo/g1/snapshots')?.body).toEqual({ name: 'Warm', params: { version: 2, exposure: 0.3, contrast: 10 }, base_id: 'g1' }))
  })

  it('Ctrl-click in the filmstrip picks photos to sync the current settings to', async () => {
    const calls = setup('/image/studio/g2', (m, p) => (m === 'POST' && p === '/photo/sync' ? { queued: 2, results: [{ id: 'm2', job_id: 'j2', error: null }, { id: 'm3', job_id: 'j3', error: null }] } : undefined))
    const user = userEvent.setup()
    const strip = await screen.findByRole('navigation', { name: 'Filmstrip' })
    fireEvent.click(await within(strip).findByRole('button', { name: 'Pier' }), { ctrlKey: true })
    fireEvent.click(within(strip).getByRole('button', { name: 'Dunes' }), { ctrlKey: true })
    await user.click(screen.getByRole('button', { name: /Sync settings to 2 photos/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Sync settings to 2 photos' })
    await user.click(within(dialog).getByRole('button', { name: 'Sync 2 photos' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/photo/sync')?.body).toMatchObject({ ids: ['m2', 'm3'], params: { version: 2, exposure: 0.3, contrast: 10 } }))
  })

  it('Tab hides the side panels; the view toolbar switches before/after modes', async () => {
    setup()
    const user = userEvent.setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.queryByRole('complementary', { name: 'Adjustments' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getByRole('complementary', { name: 'Adjustments' })).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Before and after' }), 'lr')
    expect(screen.getByRole('combobox', { name: 'Before and after' })).toHaveValue('lr')
  })
})
