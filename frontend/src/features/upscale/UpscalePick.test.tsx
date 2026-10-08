import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { upscaleOptions } from '@/test/quick-fixtures'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { UpscalePickPage } from './UpscalePickPage'

afterEach(() => vi.unstubAllGlobals())

const clip = media('v1', { kind: 'video', origin: 'upload', title: 'Harbour clip', width: 1280, height: 720, duration_s: 12, media_url: '/media/v1.mp4' })

function setup(path: string) {
  const calls = mockApi((method, p) => {
    if (p === '/media') return { items: [clip] }
    if (p === '/system/upscale-options') return upscaleOptions
    if (method === 'POST' && p === '/generations/g-v1/upscale') return { id: 'j9', type: 'upscale', status: 'queued', progress: 0, message: '', attempts: 0, created_at: clip.created_at }
  })
  renderAt(path, [{ path: '/video/upscale', element: <UpscalePickPage kind="video" /> }])
  return calls
}

describe('standalone video upscale', () => {
  it('opens the upscale dialog for a library pick with the engine from the menu preselected', async () => {
    const calls = setup('/video/upscale?engine=quick')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Harbour clip' }))
    const dialog = await screen.findByRole('dialog', { name: /Upscale “Harbour clip”/ })
    expect(await within(dialog).findByRole('radio', { name: 'Quick preview' })).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: /^Upscale to/ }))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/generations/g-v1/upscale', body: { engine: 'quick' } })
  })

  it('falls back to the default when the preselected engine is not installed', async () => {
    setup('/video/upscale?engine=best')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Harbour clip' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('radio', { name: 'Fast' })).toBeChecked()
  })
})

describe('upscale results', () => {
  afterEach(() => localStorage.clear())

  it('shows the original and the upscaled result side by side, each with its own download', async () => {
    const created = clip.created_at
    const calls = mockApi((method, p) => {
      if (p === '/media') return { items: [clip] }
      if (p === '/jobs') return []
      if (p === '/system/upscale-options') return upscaleOptions
      if (method === 'POST' && p === '/generations/g-v1/upscale')
        return { id: 'j9', type: 'upscale', status: 'queued', progress: 0, message: '', attempts: 0, created_at: created, generation_id: 'g-up' }
      if (p === '/generations/g-up')
        return { id: 'g-up', target_type: 'media', target_id: 'v1', kind: 'video', version: 2, status: 'ready', prompt: '', params: {}, media_url: '/media/up.mp4', media_type: 'video/mp4', created_at: created, parent_id: 'g-v1' }
      if (p === '/generations/g-v1')
        return { id: 'g-v1', target_type: 'media', target_id: 'v1', kind: 'upload', version: 1, status: 'ready', prompt: '', params: {}, media_url: '/media/v1.mp4', media_type: 'video/mp4', created_at: created }
    })
    renderAt('/video/upscale?engine=quick', [{ path: '/video/upscale', element: <UpscalePickPage kind="video" /> }])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Harbour clip' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /^Upscale to/ }))

    const card = await screen.findByRole('article', { name: /Upscale: Harbour clip/ })
    expect(await within(card).findByRole('link', { name: 'Download original video' })).toHaveAttribute('href', '/api/generations/g-v1/download')
    expect(await within(card).findByRole('link', { name: 'Download upscaled video' })).toHaveAttribute('href', '/api/generations/g-up/download')
    expect(calls.some((c) => c.path === '/generations/g-up')).toBe(true)
  })

  it('remembers recent upscales across visits and can forget one', async () => {
    const { rememberUpscale, loadUpscales, forgetUpscale } = await import('@/lib/upscaleHistory')
    rememberUpscale({ jobId: 'j1', sourceId: 's1', resultId: 'r1', kind: 'image', label: 'A', at: 1 })
    rememberUpscale({ jobId: 'j2', sourceId: 's2', resultId: 'r2', kind: 'video', label: 'B', at: 2 })
    expect(loadUpscales('image').map((e) => e.resultId)).toEqual(['r1'])
    expect(forgetUpscale('r1', 'image')).toEqual([])
    expect(loadUpscales('video')).toHaveLength(1)
  })
})
