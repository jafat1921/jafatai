import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { job, mockApi, renderAt } from '@/test/media-fixtures'
import { history, jpeg, schema, stubBrowser } from '@/test/photo-fixtures'
import { PhotoStudioPage } from './PhotoStudioPage'
import { forgetPhotoSession } from './session'

beforeEach(stubBrowser)
afterEach(() => {
  forgetPhotoSession()
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

  it('Smart Restore inspects, lets steps be switched off, and runs the rest', async () => {
    const plan = {
      analysis: { width: 800, height: 1000, megapixels: 0.8, is_grayscale: true, color_cast: null, cast_strength: 0, sharpness: 0.45, noise: 2,
        is_likely_blurry: true, is_likely_damaged: true },
      source: { width: 800, height: 1000 },
      message: null,
      steps: [
        { id: 's1', tool: 'scratches', label: 'Remove scratches & creases', reason: 'Fading and edge wear', on: true, available: true, variant: null, strength: 1, est_gpu_s: 35 },
        { id: 's2', tool: 'colourise', label: 'Colourise', reason: 'Black & white print', on: true, available: true, variant: 'natural', strength: 1, est_gpu_s: 9 },
        { id: 's3', tool: 'polish', label: 'Final polish', reason: 'Light levels', on: true, available: true, variant: null, strength: 0.5, est_gpu_s: 0 },
      ],
    }
    const calls = setup('/image/studio/g2', (method, p) => {
      if (p === '/photo/tools') return { tools: [], effects: [] }
      if (p === '/photo/g1/smart-plan') return plan
      if (method === 'POST' && p === '/photo/g1/smart-restore') return { chain_id: 'c1', steps: [{ tool: 'scratches', label: 'Remove scratches & creases' }, { tool: 'polish', label: 'Final polish' }], first_job_id: 'j9' }
      return undefined
    })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: 'Restore' }))
    await user.click(await screen.findByRole('button', { name: 'Inspect photo' }))
    expect(await screen.findByText(/black & white · sharpness 0.45/)).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Step 2: Colourise' }))
    await user.click(screen.getByRole('button', { name: /Restore · 2 steps/ }))
    await waitFor(() => expect(calls.find((c) => c.path === '/photo/g1/smart-restore')).toBeTruthy())
    expect((calls.find((c) => c.path === '/photo/g1/smart-restore')?.body as { steps: { tool: string }[] }).steps.map((s) => s.tool)).toEqual(['scratches', 'polish'])
    expect(await screen.findByRole('list', { name: 'Smart Restore progress' })).toHaveTextContent('2. Final polish')
  })

  it('applies a single restore tool with its option and strength', async () => {
    const tools = [{ id: 'denoise', label: 'Denoise', hint: 'Grain', group: 'clean', gpu: true, strength: true, prompt: null, noncommercial: false,
      variants: [{ id: 'strong', label: 'Strong · NAFNet' }, { id: 'gentle', label: 'Gentle · SCUNet' }], default_variant: 'strong', available: true, reason: null }]
    const calls = setup('/image/studio/g2', (method, p) => {
      if (p === '/photo/tools') return { tools, effects: [] }
      if (method === 'POST' && p === '/photo/g1/restore') return job('j5', { type: 'generate', lane: 'image', generation_id: 'g7' })
      return undefined
    })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: 'Restore' }))
    await user.click(await screen.findByRole('button', { name: /Denoise/ }))
    await user.click(screen.getByRole('radio', { name: 'Gentle · SCUNet' }))
    await user.click(screen.getByRole('button', { name: 'Apply denoise' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/photo/g1/restore')?.body).toEqual({ tool: 'denoise', variant: 'gentle', strength: 1 }))
  })

  it('Cut-out: remove background, then click points to select', async () => {
    const calls = setup('/image/studio/g2', (method, p) => {
      if (p === '/photo/tools') return { tools: [], effects: [] }
      if (method === 'POST' && p === '/photo/g1/restore') return job('j6', { type: 'generate', lane: 'image', generation_id: 'g8' })
      return undefined
    })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: 'Cut-out' }))
    await user.click(await screen.findByRole('button', { name: 'Remove background' }))
    await waitFor(() => expect(calls.find((c) => c.path === '/photo/g1/restore')?.body).toMatchObject({ tool: 'cutout' }))
    expect(screen.getByRole('button', { name: 'Apply edge & background' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'What to select' }), 'the dog')
    await user.click(screen.getByRole('button', { name: 'Select' }))
    await waitFor(() => expect(calls.filter((c) => c.path === '/photo/g1/restore')[1]?.body).toMatchObject({ tool: 'select', words: 'the dog', op: 'replace' }))
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
