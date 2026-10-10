import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analysis, audioItem, gen, peaksOf, previewResponse, stubCanvas, stubMedia, stubObjectUrls } from '@/test/audio-fixtures'
import { job, mockApi, renderAt } from '@/test/media-fixtures'
import { resetPlayer, usePlayer } from '../sharedAudio'
import { EditorPage } from './EditorPage'

const routes = [{ path: '/audio/edit/:id', element: <EditorPage /> }]

function api() {
  return mockApi((method, path) => {
    if (path === '/media/a1') return { ...audioItem('a1'), versions: [gen('g-a1', 1)] }
    if (path === '/audio/a1/peaks') return peaksOf(10)
    if (path === '/audio/a1/analysis') return analysis()
    if (method === 'POST' && path === '/audio/a1/preview') return previewResponse(-14, -1)
    if (method === 'POST' && path === '/audio/a1/render') return { item: audioItem('a1'), job: job('jr', { type: 'audio_render', lane: 'general' }) }
    if (path === '/jobs') return []
  })
}

const posts = (calls: ReturnType<typeof api>, path: string) => calls.filter((c) => c.method === 'POST' && c.path === path)

beforeEach(() => {
  stubCanvas()
  stubMedia()
  stubObjectUrls()
  resetPlayer()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function open() {
  const calls = api()
  renderAt('/audio/edit/a1', routes)
  const wave = await screen.findByRole('group', { name: 'Waveform' })
  // the waveform's length comes from the peaks
  await waitFor(() => expect(within(wave).getByText(/Rain take, 0:10\.0 long/)).toBeInTheDocument())
  return { calls, wave, user: userEvent.setup() }
}

describe('Audio editor', { timeout: 15_000 }, () => {
  it('loads the peaks and the analysis of the opened version', async () => {
    const { calls } = await open()
    const peaks = calls.find((c) => c.path === '/audio/a1/peaks')
    expect(peaks?.query).toMatchObject({ n: '4000', version: 'g-a1' })
    const a = screen.getByRole('region', { name: 'A · Original levels' })
    await waitFor(() => expect(within(a).getByText('−12.0 LUFS')).toBeInTheDocument())
    expect(within(a).getByText('5.5 LU')).toBeInTheDocument()
    expect(within(within(a).getByRole('list', { name: 'Quality warnings' })).getByText('Clipping')).toBeInTheDocument()
    // nothing to hear as B until something changes
    expect(screen.getByRole('radio', { name: 'B · Edited' })).toBeDisabled()
    expect(posts(calls, '/audio/a1/preview')).toHaveLength(0)
  })

  it('I and O mark a region, Delete cuts it, and undo / redo walk it back and forth', async () => {
    const { wave, user } = await open()
    wave.focus()
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    expect(screen.getByTestId('editor-time')).toHaveTextContent('0:02.0')
    await user.keyboard('i')
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}')
    await user.keyboard('o')
    expect(screen.getByText('Region 0:02.0 – 0:05.0')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Region start' })).toHaveAttribute('aria-valuetext', '0:02.0')

    await user.keyboard('{Delete}')
    const cuts = screen.getByRole('list', { name: 'Cuts' })
    expect(within(cuts).getByText('0:02.0 – 0:05.0')).toBeInTheDocument()
    expect(within(wave).getByText(/1 cut\./)).toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: 'Region start' })).not.toBeInTheDocument()

    await user.keyboard('{Control>}z{/Control}')
    expect(screen.queryByRole('list', { name: 'Cuts' })).not.toBeInTheDocument()
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}')
    expect(within(screen.getByRole('list', { name: 'Cuts' })).getByText('0:02.0 – 0:05.0')).toBeInTheDocument()

    // M drops a marker at the playhead, listed and renamable
    await user.keyboard('m')
    const markers = screen.getByRole('list', { name: 'Markers' })
    const name = within(markers).getByRole('textbox', { name: 'Marker 1 name' })
    expect(name).toHaveValue('Marker 1')
    await user.clear(name)
    await user.type(name, 'Thunder')
    expect(within(markers).getByRole('button', { name: 'Go to Thunder' })).toHaveTextContent('0:05.0')
  })

  it('fades, an effect and a loudness target go out as one debounced preview', async () => {
    const { calls, user } = await open()
    const fade = screen.getByRole('spinbutton', { name: 'Fade in' })
    await user.clear(fade)
    await user.type(fade, '2')
    // debounced: nothing goes out the moment something changes
    expect(posts(calls, '/audio/a1/preview')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: /^Cinematic/ }))
    await user.click(screen.getByRole('radio', { name: /^Web/ }))

    const last = () => posts(calls, '/audio/a1/preview').at(-1)?.body as { edit?: { loudness?: unknown } } | undefined
    await waitFor(() => expect(last()?.edit?.loudness).toEqual({ target: 'web' }), { timeout: 3000 })
    const sent = posts(calls, '/audio/a1/preview')
    expect(sent[sent.length - 1].body).toEqual({
      edit: { version: 1, fade_in: { s: 2, curve: 'qsin' }, chain: { preset: 'cinematic', amount: 70 }, loudness: { target: 'web' } },
      version: 'g-a1',
    })
    const b = await screen.findByRole('region', { name: 'B · Edited levels' })
    await waitFor(() => expect(within(b).getByText('−14.0 LUFS')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.getByText(/Fade in 2 s · Web −14 LUFS/)).toBeInTheDocument()
  })

  it('Save as version posts the compacted edit with a note', async () => {
    const { calls, user } = await open()
    await user.click(screen.getByRole('radio', { name: /^Broadcast/ }))
    await user.click(screen.getByRole('button', { name: 'Save as version' }))
    await waitFor(() => expect(posts(calls, '/audio/a1/render')).toHaveLength(1))
    expect(posts(calls, '/audio/a1/render')[0].body).toEqual({ edit: { version: 1, loudness: { target: 'broadcast' } }, version: 'g-a1', note: 'Broadcast −23 LUFS' })
    expect(await screen.findByRole('button', { name: 'Save as version' })).toBeDisabled()
  })

  it('the export drawer builds the download address from the format and loudness', async () => {
    const { user } = await open()
    await user.click(screen.getByRole('button', { name: 'Export' }))
    const drawer = await screen.findByRole('dialog', { name: 'Export' })
    await user.click(within(drawer).getByRole('radio', { name: 'FLAC' }))
    await user.selectOptions(within(drawer).getByRole('combobox'), 'podcast')
    const link = within(drawer).getByRole('link', { name: /Download FLAC/ })
    expect(link).toHaveAttribute('href', '/api/audio/a1/export?format=flac&loudness=podcast&version=g-a1')
    expect(link).toHaveAttribute('download', 'Rain-take.flac')
  })

  it('A/B switches between the original and the edit, level-matched, keeping the moment', async () => {
    const { wave, user } = await open()
    await user.click(screen.getByRole('radio', { name: /^Podcast/ }))
    await screen.findByText(/Preview ready/, undefined, { timeout: 3000 })

    wave.focus()
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}')
    await user.click(screen.getByRole('button', { name: 'Play A' }))
    expect(usePlayer.getState()).toMatchObject({ id: 'editA:a1', src: '/media/g-a1.flac', playing: true, time: 3 })
    // A measured −12, B −14: A plays 2 dB down
    await waitFor(() => expect(usePlayer.getState().gain).toBeCloseTo(10 ** (-2 / 20), 3))

    await user.click(screen.getByRole('radio', { name: 'B · Edited' }))
    expect(usePlayer.getState()).toMatchObject({ id: 'editB:a1', src: 'blob:preview', playing: true, time: 3 })
    await waitFor(() => expect(usePlayer.getState().gain).toBe(1))
    expect(screen.getByRole('radio', { name: 'B · Edited' })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('checkbox', { name: 'Level-matched' }))
    await user.click(screen.getByRole('radio', { name: 'A · Original' }))
    expect(usePlayer.getState()).toMatchObject({ id: 'editA:a1', time: 3 })
    await waitFor(() => expect(usePlayer.getState().gain).toBe(1))
  })
})
