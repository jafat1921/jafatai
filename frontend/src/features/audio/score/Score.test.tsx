import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audioItem, peaksOf, previewResponse, stubCanvas, stubMedia, stubObjectUrls } from '@/test/audio-fixtures'
import { job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { resetPlayer, usePlayer } from '../sharedAudio'
import { resetDraft } from './draft'
import { ScorePage } from './ScorePage'

const routes = [{ path: '/audio/score', element: <ScorePage /> }]
const clip = media('v1', { kind: 'video', title: 'Harbour at dusk', duration_s: 12, media_url: '/media/v1.mp4', thumb_url: '/media/v1.webp' })
const rain = audioItem('a1')
const bed = audioItem('a2', { title: 'Strings bed', params: { kind: 'music' } })

function api() {
  return mockApi((method, path, query) => {
    if (path === '/media') return { items: query.kind === 'audio' ? [rain, bed] : query.kind === 'video' ? [clip] : [] }
    if (path === '/media/v1') return { ...clip, versions: [] }
    if (path === '/media/a1') return { ...rain, versions: [] }
    if (/^\/audio\/a\d\/peaks$/.test(path)) return peaksOf(10)
    if (method === 'POST' && path === '/audio/mix/preview') return previewResponse(-15, -1.5)
    if (method === 'POST' && path === '/audio/mix') return { item: { ...clip, title: 'Harbour at dusk' }, job: job('jm', { type: 'audio_mix', lane: 'general' }) }
    if (path === '/jobs') return []
  })
}

beforeEach(() => {
  stubCanvas()
  stubMedia()
  stubObjectUrls('blob:mix')
  resetPlayer()
  resetDraft()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Score a Clip', { timeout: 15_000 }, () => {
  it('lays tracks under a video, previews the mix in sync, and saves a new video version', async () => {
    const calls = api()
    renderAt('/audio/score?video=v1&audio=a1', routes)
    const user = userEvent.setup()

    expect(await screen.findByRole('heading', { name: /Timeline · 0:12\.0/ })).toBeInTheDocument()
    const lanes = screen.getByRole('list', { name: 'Lanes' })
    expect(await within(lanes).findByRole('listitem', { name: 'Rain take' })).toBeInTheDocument()

    // a second lane from the Library
    await user.click(screen.getByRole('button', { name: 'Add from Library' }))
    const picker = await screen.findByRole('dialog', { name: 'Add tracks' })
    await user.click(await within(picker).findByRole('button', { name: /Strings bed/ }))
    await user.click(within(picker).getByRole('button', { name: /^Add/ }))
    const strings = await within(lanes).findByRole('listitem', { name: 'Strings bed' })
    // music ducks by default; an effect doesn't
    expect(within(strings).getByRole('checkbox', { name: 'Duck under dialogue' })).toBeChecked()

    const block = screen.getByRole('slider', { name: 'Start of Rain take' })
    block.focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{/Shift}')
    expect(block).toHaveAttribute('aria-valuenow', '1.3')
    expect(block).toHaveAttribute('aria-valuetext', 'Starts at 0:01.3')

    const rainRow = within(lanes).getByRole('listitem', { name: 'Rain take' })
    await user.click(within(rainRow).getByRole('checkbox', { name: 'Duck under dialogue' }))
    await user.click(within(strings).getByRole('button', { name: 'Solo Strings bed' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Duck amount' }), { target: { value: '14' } })

    await user.click(screen.getByRole('button', { name: 'Render preview' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/audio/mix/preview')).toBe(true))
    const track = { gain_db: 0, fade_in_s: 0, fade_out_s: 0, loop: false }
    const body = {
      video_id: 'v1',
      original: { keep: true, gain_db: 0 },
      tracks: [
        // soloing the strings mutes the rain
        { media_id: 'a1', offset_s: 1.3, mute: true, duck: true, ...track },
        { media_id: 'a2', offset_s: 0, mute: false, duck: true, ...track },
      ],
      duck: { amount_db: 14, under: 'original' },
    }
    expect(calls.find((c) => c.path === '/audio/mix/preview')?.body).toEqual(body)
    expect(await screen.findByText('Mix −15.0 LUFS · −1.5 dBTP')).toBeInTheDocument()

    // loaded, never started by itself; Play runs the mix and the muted video together
    expect(usePlayer.getState()).toMatchObject({ id: 'mix:v1', src: 'blob:mix', playing: false })
    const video = document.querySelector('video')!
    expect(video.muted).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Play the mix with the video' }))
    expect(usePlayer.getState().playing).toBe(true)
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2))

    await user.click(screen.getByRole('checkbox', { name: /Also export stems/ }))
    await user.click(screen.getByRole('button', { name: 'Save as new video version' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/audio/mix')).toBe(true))
    expect(calls.find((c) => c.method === 'POST' && c.path === '/audio/mix')?.body).toEqual({ ...body, stems: true })
    expect(await screen.findByRole('link', { name: 'Open the video Library' })).toHaveAttribute('href', '/video/library')
  })

  it('asks for a video first', async () => {
    api()
    renderAt('/audio/score', routes)
    expect(await screen.findByRole('heading', { name: 'Pick a video to score' })).toBeInTheDocument()
  })

  it('Generate at clip length opens the generators with the clip’s length', async () => {
    api()
    renderAt('/audio/score?video=v1', routes)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: /Timeline · 0:12\.0/ })
    await user.click(screen.getByRole('button', { name: 'Generate at clip length' }))
    expect(await screen.findByRole('menuitem', { name: /Music & Score · 0:12/ })).toHaveAttribute('href', '/audio/music?duration=12&from=score')
  })
})
