import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { job, mockApi, renderAt } from '@/test/media-fixtures'
import { history, jpeg, schema, stubBrowser } from '@/test/photo-fixtures'
import { PhotoStudioPage } from './PhotoStudioPage'

beforeEach(stubBrowser)
afterEach(() => {
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
    if (p === '/media/m1') return { id: 'm1', title: 'Lighthouse', versions: [] }
    if (method === 'POST' && p.endsWith('/render')) return job('j1', { type: 'photo_render', lane: 'general', generation_id: 'g3' })
    if (p === '/looks') return []
    return undefined
  })
  renderAt(path, [{ path: '/image/studio/:generationId', element: <PhotoStudioPage /> }])
  return calls
}

const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement

describe('Photo Studio', () => {
  it('opens a developed version on its base, with its saved settings, and previews on the server without WebGL', async () => {
    const calls = setup()
    expect(await screen.findByRole('heading', { name: /^Photo Studio · Lighthouse/ })).toBeInTheDocument()
    expect(slider('Exposure')).toHaveValue('20')
    expect(slider('Contrast')).toHaveValue('10')
    // the base (g1) is what renders, with the stored params: no stacking of edits
    await waitFor(() => expect(calls.find((c) => c.path === '/photo/g1/preview')).toBeTruthy())
    expect(calls.find((c) => c.path === '/photo/g1/preview')?.body).toEqual({ params: { exposure: 20, contrast: 10 }, max_side: 1280 })
    expect(await screen.findByText(/Exact preview/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /exact preview/ })).toHaveAttribute('src', 'blob:preview-1')
  })

  it('shows Restore and Cut-out, switched off until the models are installed', async () => {
    setup()
    const tabs = await screen.findByRole('tablist', { name: 'Photo Studio tools' })
    expect(within(tabs).getByRole('tab', { name: 'Restore' })).toBeDisabled()
    expect(within(tabs).getByRole('tab', { name: 'Cut-out' })).toBeDisabled()
    expect(within(tabs).getByRole('tab', { name: 'Develop' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/Coming next — needs the photo models on the server/)).toBeInTheDocument()
  })

  it('saves the current settings from the base as a new version (Ctrl+S)', async () => {
    const calls = setup()
    const user = userEvent.setup()
    const exposure = await screen.findByRole('slider', { name: 'Exposure' })
    exposure.focus()
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(exposure).toHaveValue('30')
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/photo/g1/render')).toBeTruthy())
    expect(calls.find((c) => c.path === '/photo/g1/render')?.body).toEqual({ params: { exposure: 30, contrast: 10 }, format: 'jpeg' })
  })

  it('exports a 16-bit TIFF as a new version', async () => {
    const calls = setup()
    const user = userEvent.setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    await user.click(screen.getByRole('button', { name: 'Export' }))
    await user.click(await screen.findByRole('menuitem', { name: /TIFF 16-bit/ }))
    await waitFor(() => expect(calls.find((c) => c.path === '/photo/g1/render')?.body).toMatchObject({ format: 'tiff16' }))
  })

  it('Auto merges its suggestion in one undoable step', async () => {
    const calls = setup('/image/studio/g2', (method, p) =>
      method === 'POST' && p === '/photo/g1/auto' ? { params: { exposure: 38, shadows: 20 }, notes: ['Underexposed: +0.6 stops'] } : undefined,
    )
    const user = userEvent.setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    await user.click(screen.getByRole('button', { name: 'Auto' }))
    await waitFor(() => expect(slider('Exposure')).toHaveValue('38'))
    expect(calls.some((c) => c.path === '/photo/g1/auto')).toBe(true)
    expect(slider('Shadows')).toHaveValue('20')
    expect(slider('Contrast')).toHaveValue('10')
    expect(screen.getByText('Underexposed: +0.6 stops')).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(slider('Exposure')).toHaveValue('20')
    expect(slider('Shadows')).toHaveValue('0')
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(slider('Exposure')).toHaveValue('38')
    await user.click(screen.getByRole('button', { name: 'Undo (Ctrl+Z)' }))
    expect(slider('Exposure')).toHaveValue('20')
  })

  it('Reset clears everything and can be undone', async () => {
    setup()
    const user = userEvent.setup()
    await screen.findByRole('slider', { name: 'Exposure' })
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(slider('Exposure')).toHaveValue('0')
    expect(screen.getByRole('button', { name: 'Save as new version' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Undo (Ctrl+Z)' }))
    expect(slider('Exposure')).toHaveValue('20')
  })

  it('History loads a version’s settings, makes an older version current, and compares two', async () => {
    const calls = setup('/image/studio/g1', (method, p) => (method === 'POST' && p === '/photo/g1/revert' ? { ...history(), current_id: 'g1' } : undefined))
    const user = userEvent.setup()
    // opened on the original: nothing applied yet
    expect(await screen.findByRole('slider', { name: 'Exposure' })).toHaveValue('0')
    await user.click(screen.getByRole('button', { name: 'History' }))
    const panel = await screen.findByRole('dialog', { name: 'History' })
    const items = within(panel).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('v2')
    expect(items[0]).toHaveTextContent('Exposure +20 · Contrast +10')
    await user.click(within(items[0]).getByRole('button', { name: 'Load settings' }))
    expect(slider('Exposure')).toHaveValue('20')

    await user.click(screen.getByRole('button', { name: 'History' }))
    const again = await screen.findByRole('dialog', { name: 'History' })
    const v1 = within(again).getAllByRole('listitem')[1]
    await user.click(within(v1).getByRole('button', { name: 'Make current' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/photo/g1/revert')).toBe(true))

    await user.click(within(again).getByRole('checkbox', { name: 'Compare v1' }))
    await user.click(within(again).getByRole('checkbox', { name: 'Compare v2' }))
    await user.click(within(again).getByRole('button', { name: 'Compare' }))
    expect(await screen.findByRole('heading', { name: 'Compare v1 and v2' })).toBeInTheDocument()
  })

  it('the filmstrip lists every version and marks the open one', async () => {
    setup()
    const strip = await screen.findByRole('list', { name: 'Filmstrip' })
    const buttons = within(strip).getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Version 1, Original upload', 'Version 2, Developed, current'])
    expect(buttons[1]).toHaveAttribute('aria-current', 'true')
  })

  it('explains when the picture can’t be opened', async () => {
    mockApi((_m, p) => (p.endsWith('/history') ? new Response(JSON.stringify({ detail: 'Not an image' }), { status: 422 }) : undefined))
    renderAt('/image/studio/v9', [{ path: '/image/studio/:generationId', element: <PhotoStudioPage /> }])
    expect(await screen.findByText("Couldn't open this picture in Photo Studio")).toBeInTheDocument()
    expect(screen.getByText('Not an image')).toBeInTheDocument()
  })
})
