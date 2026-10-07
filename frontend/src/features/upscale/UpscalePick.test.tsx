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
