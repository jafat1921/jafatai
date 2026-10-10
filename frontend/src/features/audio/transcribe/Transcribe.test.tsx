import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transcript } from '@/lib/dub'
import { audioItem, stubMedia } from '@/test/audio-fixtures'
import { T, job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { ENGINES } from '@/test/voice-fixtures'
import { resetPlayer, usePlayer } from '../sharedAudio'
import { TranscribePage } from './TranscribePage'

const routes = [{ path: '/audio/transcribe', element: <TranscribePage /> }]
const clip = media('v1', { kind: 'video', title: 'Harbour at dusk', duration_s: 6, media_url: '/media/v1.mp4', thumb_url: '/media/v1.webp' })

const transcript = (extra: Partial<Transcript> = {}): Transcript => ({
  id: 't1',
  media_id: 'v1',
  generation_id: 'g-v1',
  title: 'Harbour at dusk',
  language: 'en',
  text: 'The boat left at dawn. Um, nobody said a word.',
  segments: [
    { start: 0, end: 2.2, text: 'The boat left at dawn.', words: [{ start: 0, end: 0.4, w: 'The' }] },
    { start: 2.5, end: 4.7, text: 'Um, nobody said a word.', clean: 'Nobody said a word.' },
  ],
  cleanup_text: 'The boat left at dawn. Nobody said a word.',
  status: 'done',
  error: null,
  job_id: 'j1',
  duration_s: 6,
  words: true,
  created_at: T,
  updated_at: T,
  job: null,
  media: { ...clip, versions: [] },
  ...extra,
})

function api(t: Transcript) {
  return mockApi((method, path, query) => {
    if (path === '/voices/engines') return ENGINES
    if (path === '/jobs') return []
    if (path === '/media') return { items: query.kind === 'video' ? [clip] : [audioItem('a1')] }
    if (method === 'GET' && path === '/transcripts') return [{ ...t, segments: undefined }]
    if (method === 'POST' && path === '/transcribe') return { transcript_id: 't9', job: job('j9', { type: 'transcribe', lane: 'audio' }) }
    if (method === 'GET' && path === '/transcripts/t9') return transcript({ id: 't9', status: 'running', segments: [], cleanup_text: null, job: job('j9', { status: 'running', progress: 0.4, message: 'Transcribing' }) })
    if (method === 'GET' && path === '/transcripts/t1') return t
    if (method === 'POST' && path === '/transcripts/t1/cleanup') return job('c1', { type: 'transcript_cleanup' })
    if (method === 'POST' && path === '/transcripts/t1/video') return { job: job('x1', { type: 'transcript_video' }), item_id: 'v1', generation_id: 'gx' }
    return undefined
  })
}

const sent = (calls: { method: string; path: string; body: unknown }[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).map((c) => c.body)

beforeEach(() => {
  stubMedia()
  resetPlayer()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Transcribe', () => {
  it('transcribes a picked video in a chosen language and opens it', async () => {
    const calls = api(transcript())
    const user = userEvent.setup()
    renderAt('/audio/transcribe', routes)
    const panel = screen.getByRole('region', { name: 'New transcript' })
    expect(within(panel).getByRole('button', { name: 'Transcribe' })).toBeDisabled()
    await user.click(within(panel).getByRole('button', { name: 'Pick a video' }))
    await user.click(await screen.findByRole('button', { name: /Harbour at dusk/ }))
    await user.click(screen.getByRole('button', { name: /Use this/ }))
    expect(within(panel).getByText('Harbour at dusk')).toBeInTheDocument()
    await user.selectOptions(within(panel).getByRole('combobox', { name: 'Language' }), 'ur')
    await user.click(within(panel).getByRole('checkbox', { name: /Tidy it with the LLM/ }))
    await user.click(within(panel).getByRole('button', { name: 'Transcribe' }))

    await waitFor(() => expect(sent(calls, 'POST', '/transcribe')).toEqual([{ media_id: 'v1', language: 'ur', words: true, cleanup: true }]))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/audio/transcribe?t=t9'))
    expect(await screen.findByText('Transcribing')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Transcript progress' })).toBeInTheDocument()
  })

  it('shows the timed lines: seek from a timestamp, search, tidy toggle and subtitle files', async () => {
    api(transcript())
    const user = userEvent.setup()
    renderAt('/audio/transcribe?t=t1', routes)
    const list = await screen.findByRole('list', { name: 'Transcript' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    // the tidied text shows first when there is one
    expect(within(list).getByText('Nobody said a word.')).toBeInTheDocument()

    await user.click(within(list).getByRole('button', { name: 'Play from 0:02.5' }))
    const p = usePlayer.getState()
    expect(p.id).toBe('transcript:t1')
    expect(p.src).toBe('/media/v1.mp4')
    expect(p.time).toBe(2.5)

    await user.click(screen.getByRole('checkbox', { name: 'Tidied text' }))
    expect(within(list).getByText('Um, nobody said a word.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SRT' })).toHaveAttribute('href', '/api/transcripts/t1/subtitles?format=srt')
    expect(screen.getByRole('link', { name: 'VTT' })).toHaveAttribute('href', '/api/transcripts/t1/subtitles?format=vtt')

    await user.type(screen.getByRole('textbox', { name: 'Search the transcript' }), 'dawn')
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('dawn', { selector: 'mark' })).toBeInTheDocument()
  })

  it('asks the LLM to tidy, and makes subtitles for the video', async () => {
    const calls = api(transcript({ cleanup_text: null, segments: [{ start: 0, end: 2, text: 'Um, the boat.' }] }))
    const user = userEvent.setup()
    renderAt('/audio/transcribe?t=t1', routes)
    await user.click(await screen.findByRole('button', { name: 'Tidy with the LLM' }))
    await waitFor(() => expect(sent(calls, 'POST', '/transcripts/t1/cleanup')).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: 'Burn them in' }))
    await waitFor(() => expect(sent(calls, 'POST', '/transcripts/t1/video')).toEqual([{ mode: 'burn', clean: false }]))
    expect(await screen.findByText(/the new version appears on the video/)).toBeInTheDocument()
  })
})
