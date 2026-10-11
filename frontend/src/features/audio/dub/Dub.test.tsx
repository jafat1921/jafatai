import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DUB_STAGES, type Dub, type DubSegment, type DubStage, type DubStageName } from '@/lib/dub'
import type { GalleryVoice } from '@/lib/gallery'
import { stubMedia } from '@/test/audio-fixtures'
import { closeChip, openChip } from '@/test/dock'
import { T, job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { ENGINES, VOICES } from '@/test/voice-fixtures'
import { resetPlayer, usePlayer } from '../sharedAudio'
import { DubListPage } from './DubListPage'
import { DubWorkspacePage } from './DubWorkspacePage'

const routes = [
  { path: '/audio/dub', element: <DubListPage /> },
  { path: '/audio/dub/:id', element: <DubWorkspacePage /> },
]

const gv = (id: string, name: string, lang: string, extra: Partial<GalleryVoice> = {}): GalleryVoice => ({
  id,
  voice_id: `gallery:${id}`,
  name,
  language: lang,
  languages: [lang],
  gender: 'female',
  age: 'adult',
  accent: lang === 'ur' ? 'Urdu' : 'American',
  styles: ['warm'],
  engine: 'omnivoice',
  kind: 'design',
  instruct: 'female, elderly',
  seed: 1,
  sample_url: `/api/voices/gallery/${id}/sample`,
  sample_ready: false,
  added_voice_id: null,
  starred: false,
  ...extra,
})
const GALLERY = [gv('ur-dadi', 'Dadi Amma, grandmother', 'ur'), gv('en-uk-news', 'Charlotte, UK newsreader', 'en')]

const clip = media('v1',{ kind: 'video', title: 'Harbour at dusk', duration_s: 6, media_url: '/media/v1.mp4', thumb_url: '/media/v1.webp' })

const stagesUpTo = (upto: DubStageName | null, at?: Partial<DubStage> & { name: DubStageName }) =>
  Object.fromEntries(
    DUB_STAGES.map((s, i) => [s, { status: upto && i <= DUB_STAGES.indexOf(upto) ? 'done' : 'pending', progress: 0, ...(at?.name === s ? at : {}) }]),
  ) as Record<DubStageName, DubStage>

const seg = (id: string, start: number, speaker: string, text: string, ur?: DubSegment['target']['ur']): DubSegment => ({
  id,
  start,
  end: start + 2,
  speaker_id: speaker,
  source_text: text,
  words: [],
  target: ur ? { ur } : {},
})

function dub(extra: Partial<Dub> = {}): Dub {
  return {
    id: 'd1',
    video_id: 'v1',
    video_generation_id: 'g-v1',
    title: 'Harbour at dusk',
    source_language: 'en',
    targets: ['ur'],
    stage: 'speakers',
    stages: stagesUpTo('transcribe', { name: 'speakers', status: 'review' }),
    settings: { quality: 'fast', fit: 'smart', keep_background: true, background_db: 0, voice_match: 'per_speaker', speakers: 'auto' },
    tracks: {},
    duration_s: 6,
    video_url: '/media/v1.mp4',
    job: null,
    segment_count: 3,
    speaker_count: 2,
    created_at: T,
    updated_at: T,
    speakers: [
      { id: 'spk1', label: 'Speaker 1', voice_id: null, sample_media_id: 'smp1', sample_url: '/media/smp1.flac', sample_duration_s: 7.5 },
      { id: 'spk2', label: 'Speaker 2', voice_id: null, sample_media_id: 'smp2', sample_url: '/media/smp2.flac', sample_duration_s: 2.1 },
    ],
    segments: [seg('s1', 0, 'spk1', 'The boat left at dawn.'), seg('s2', 2.5, 'spk2', 'Nobody said a word.'), seg('s3', 5, 'spk2', 'Not yet.')],
    glossary: [],
    stems: { vocals: '/media/vocals.wav', instrumental: '/media/bed.wav' },
    ...extra,
  }
}

const translated = () =>
  dub({
    stage: 'mix',
    stages: stagesUpTo('mix'),
    tracks: { ur: { media_id: 'tr1', generation_id: 'gt1', built_at: T, url: '/media/tr1.flac' } },
    segments: [
      seg('s1', 0, 'spk1', 'The boat left at dawn.', { text: 'کشتی صبح نکلی۔', status: 'verified', fit: 'smart', tempo: 1.25, take_id: 's1.1', take_url: '/media/s1.flac', verify: { wer: 0.5, overrun_s: 0, flags: ['wer'] } }),
      seg('s2', 2.5, 'spk2', 'Nobody said a word.', { text: 'کوئی نہیں بولا۔', status: 'stale', fit: 'smart', take_id: 's2.1' }),
      seg('s3', 5, 'spk2', 'Not yet.', { text: 'ابھی نہیں۔', status: 'verified', fit: 'strict', take_id: 's3.1' }),
    ],
  })

function api(initial: Dub) {
  let current = initial
  return mockApi((method, path, query, body) => {
    const b = body as Record<string, unknown>
    if (path === '/voices/engines') return ENGINES
    if (path === '/voices') return VOICES
    if (path === '/voices/gallery') return { items: GALLERY, total: GALLERY.length, facets: {} }
    if (path === '/jobs') return []
    if (path === '/media') return { items: query.kind === 'video' ? [clip] : [] }
    if (method === 'GET' && path === '/dubs') return [{ ...current, segments: undefined }]
    if (method === 'POST' && path === '/dubs') return dub({ id: 'd9', stage: 'extract', stages: stagesUpTo(null), job: job('j1', { type: 'dub_stage', lane: 'general' }) })
    if (method === 'GET' && path === '/dubs/d1') return current
    if (method === 'PATCH' && path === '/dubs/d1') {
      const edits = (b.segments as { id: string; source_text?: string }[] | undefined) ?? []
      current = {
        ...current,
        segments: current.segments.map((s) => {
          const e = edits.find((x) => x.id === s.id)
          return e?.source_text ? { ...s, source_text: e.source_text } : s
        }),
      }
      return current
    }
    if (method === 'POST' && path === '/dubs/d1/continue') {
      current = { ...current, stage: 'translate', stages: stagesUpTo('speakers', { name: 'translate', status: 'pending' }), job: job('j2', { type: 'dub_stage', status: 'queued' }) }
      return current
    }
    if (method === 'POST' && path === '/dubs/d1/regen') return { ...current, regen: { lang: 'ur', segment_ids: ['s2'], from: 'render' } }
    if (method === 'POST' && path === '/dubs/d1/segments/merge') return current
    if (method === 'POST' && path === '/dubs/d1/export') return { job: job('x1', { type: 'dub_export', lane: 'general' }), item_id: 'v1', generation_id: 'gx' }
    if (method === 'POST' && path === '/text/aerab') return { text: (b.text as string).replace('کشتی', 'کَشتی'), marked: 1, kept: 0, low_coverage: 1, language: b.language }
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

describe('Dub list', () => {
  it('starts a dub of a picked video into Urdu by default', async () => {
    const calls = api(dub())
    const user = userEvent.setup()
    renderAt('/audio/dub', routes)
    expect(await screen.findByRole('link', { name: 'Harbour at dusk' })).toHaveAttribute('href', '/audio/dub/d1')
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()

    const form = screen.getByRole('form', { name: 'New dub' })
    expect(within(form).getByRole('button', { name: 'New dub' })).toBeDisabled()
    expect(within(form).getByRole('button', { name: 'Urdu' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(form).getByRole('button', { name: 'Pick a video' }))
    await user.click(await screen.findByRole('button', { name: /Harbour at dusk/ }))
    await user.click(screen.getByRole('button', { name: /Dub this/ }))
    await user.click(within(form).getByRole('button', { name: 'English' }))
    await user.click(within(form).getByRole('radio', { name: 'Fixed' }))
    const n = within(form).getByRole('spinbutton', { name: 'Number of speakers' })
    await user.clear(n)
    await user.type(n, '3')
    await user.click(within(form).getByRole('radio', { name: 'Careful' }))
    await user.click(within(form).getByRole('button', { name: 'New dub' }))

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/audio/dub/d9'))
    expect(sent(calls, 'POST', '/dubs')[0]).toEqual({ video_id: 'v1', targets: ['ur', 'en'], speakers: 3, settings: { quality: 'careful' } })
  })
})

describe('Dub workspace', () => {
  it('stops at the transcript checkpoint, edits a line from the keyboard and continues', async () => {
    const calls = api(dub())
    const user = userEvent.setup()
    renderAt('/audio/dub/d1', routes)
    expect(await screen.findByText(/^Transcript ready — fix any mistakes/)).toBeInTheDocument()
    const steps = screen.getByRole('list', { name: 'Dub steps' })
    expect(within(steps).getByText('Speakers').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(within(steps).getByText(/waiting for your review/)).toBeInTheDocument()

    const lines = screen.getByRole('listbox', { name: /Lines/ })
    expect(within(lines).getAllByRole('option')).toHaveLength(3)
    lines.focus()
    await user.keyboard('{ArrowDown}')
    expect(lines).toHaveAttribute('aria-activedescendant', 'dub-row-s2')
    await user.keyboard('{Enter}')
    const source = screen.getByRole('textbox', { name: 'Heard (transcript)' })
    expect(source).toHaveFocus()
    await user.clear(source)
    await user.type(source, 'Nobody said a single word.')
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => expect(sent(calls, 'PATCH', '/dubs/d1')).toEqual([{ segments: [{ id: 's2', source_text: 'Nobody said a single word.' }] }]))
    // saved and moved on to the next line
    await waitFor(() => expect(lines).toHaveAttribute('aria-activedescendant', 'dub-row-s3'))

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(sent(calls, 'POST', '/dubs/d1/continue')).toHaveLength(1))
  })

  it('shows flags and fit, regenerates the changed lines, bulk edits and merges', async () => {
    const calls = api(translated())
    const user = userEvent.setup()
    renderAt('/audio/dub/d1', routes)
    const lines = await screen.findByRole('listbox', { name: 'Lines, Urdu' })
    const first = within(lines).getAllByRole('option')[0]
    expect(first).toHaveAccessibleName(/Urdu: کشتی صبح نکلی۔\. Heard differently \(WER 50%\)/)
    expect(within(first).getByText('Smart fit · 1.25×')).toBeInTheDocument()
    expect(within(lines).getByText('Changed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Regen 1 changed' }))
    await waitFor(() => expect(sent(calls, 'POST', '/dubs/d1/regen')).toEqual([{ lang: 'ur' }]))

    const rows = within(lines).getAllByRole('option')
    fireEvent.click(rows[1], { ctrlKey: true })
    fireEvent.click(rows[2], { ctrlKey: true })
    const bar = screen.getByRole('toolbar', { name: 'Selected lines' })
    expect(within(bar).getByText('2 selected')).toBeInTheDocument()
    await user.selectOptions(within(bar).getByRole('combobox', { name: 'Set the timing fit' }), 'stretch')
    await waitFor(() =>
      expect(sent(calls, 'PATCH', '/dubs/d1')).toEqual([{ segments: [{ id: 's2', target: { ur: { fit: 'stretch' } } }, { id: 's3', target: { ur: { fit: 'stretch' } } }] }]),
    )
    await user.click(within(bar).getByRole('button', { name: 'Merge' }))
    await waitFor(() => expect(sent(calls, 'POST', '/dubs/d1/segments/merge')).toEqual([{ segment_ids: ['s2', 's3'] }]))
  })

  it('adds aerab to the target line, undoes it, and saves the marked line', async () => {
    const calls = api(translated())
    const user = userEvent.setup()
    renderAt('/audio/dub/d1', routes)
    const lines = await screen.findByRole('listbox', { name: 'Lines, Urdu' })
    lines.focus()
    await user.keyboard('{Enter}')
    const target = screen.getByRole('textbox', { name: 'Urdu' })
    expect(target).toHaveValue('کشتی صبح نکلی۔')

    await user.click(screen.getByRole('button', { name: 'Add aerab to the Urdu line' }))
    await waitFor(() => expect(target).toHaveValue('کَشتی صبح نکلی۔'))
    expect(sent(calls, 'POST', '/text/aerab')[0]).toEqual({ text: 'کشتی صبح نکلی۔', language: 'ur' })
    expect(screen.getByText(/Aerab added to 1 line\. 1 line still lightly marked/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Undo aerab on the Urdu line' }))
    expect(target).toHaveValue('کشتی صبح نکلی۔')

    await user.click(screen.getByRole('button', { name: 'Add aerab to the Urdu line' }))
    await waitFor(() => expect(target).toHaveValue('کَشتی صبح نکلی۔'))
    await user.click(screen.getByRole('button', { name: 'Save line' }))
    await waitFor(() => expect(sent(calls, 'PATCH', '/dubs/d1')).toEqual([{ segments: [{ id: 's1', target: { ur: { text: 'کَشتی صبح نکلی۔' } } }] }]))
  })

  it('A/B keeps the playhead: the dub track takes over at the picture’s time', async () => {
    api(translated())
    const user = userEvent.setup()
    renderAt('/audio/dub/d1', routes)
    const video = (await screen.findByLabelText(/Harbour at dusk: original sound/)) as HTMLVideoElement
    video.currentTime = 3
    await user.click(await screen.findByRole('radio', { name: 'Dub · Urdu' }))
    await waitFor(() => expect(video.muted).toBe(true))
    const p = usePlayer.getState()
    expect(p.id).toBe('dub:d1:ur')
    expect(p.src).toBe('/media/tr1.flac')
    expect(p.time).toBe(3)

    await user.click(screen.getByRole('radio', { name: 'Original' }))
    await waitFor(() => expect(video.muted).toBe(false))

    // L jumps the picture five seconds on
    await user.click(document.body)
    await user.keyboard('l')
    expect(video.currentTime).toBe(8)
  })

  it('casts a library or a gallery voice, and clones a speaker with the consent still asked', async () => {
    const calls = api(translated())
    const user = userEvent.setup()
    renderAt('/audio/dub/d1', routes)
    await user.click(await screen.findByRole('tab', { name: 'Cast' }))
    const cards = screen.getByRole('list', { name: 'Speakers' })
    expect(within(cards).getByRole('button', { name: 'Voice of Speaker 1: Stand-in voice' })).toBeInTheDocument()
    let pop = await openChip(user, 'Voice of Speaker 1')
    await user.click(within(within(pop).getByRole('list', { name: 'Voice of Speaker 1 choices' })).getByRole('button', { name: /Ayesha/ }))
    await waitFor(() => expect(sent(calls, 'PATCH', '/dubs/d1')).toEqual([{ speakers: [{ id: 'spk1', voice_id: 'v1' }] }]))
    await closeChip(user)

    // the Gallery section starts on the dub's target language
    pop = await openChip(user, 'Voice of Speaker 2')
    const gallery = within(pop).getByRole('region', { name: 'Gallery' })
    expect(within(gallery).getByRole('combobox', { name: 'Gallery language' })).toHaveValue('ur')
    const choices = within(gallery).getByRole('list', { name: 'Voice of Speaker 2 gallery choices' })
    expect(within(choices).getAllByRole('button')).toHaveLength(1)
    await user.click(within(choices).getByRole('button', { name: /Dadi Amma/ }))
    await waitFor(() => expect(sent(calls, 'PATCH', '/dubs/d1')[1]).toEqual({ speakers: [{ id: 'spk2', voice_id: 'gallery:ur-dadi' }] }))
    await closeChip(user)
    // too short a sample to clone from
    expect(within(cards).getAllByRole('button', { name: 'Clone this speaker' })[1]).toBeDisabled()

    await user.click(within(cards).getAllByRole('button', { name: 'Clone this speaker' })[0])
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Speaker 1, cut from the video')).toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'Voice name' })).toHaveValue('Harbour at dusk · Speaker 1')
    expect(within(dialog).getByRole('button', { name: 'Create voice' })).toBeDisabled()
    expect(within(dialog).getByText('Type the name of the person who agreed.')).toBeInTheDocument()
  })

  it('exports with burned-in subtitles and saves the glossary', async () => {
    const calls = api(translated())
    const user = userEvent.setup()
    renderAt('/audio/dub/d1', routes)
    await user.click(await screen.findByRole('button', { name: 'Export' }))
    const drawer = await screen.findByRole('dialog')
    await user.click(within(drawer).getByRole('radio', { name: /Burned in/ }))
    await user.click(within(drawer).getByRole('checkbox', { name: /Stems zip/ }))
    await user.click(within(drawer).getByRole('button', { name: 'Export MP4' }))
    await waitFor(() =>
      expect(sent(calls, 'POST', '/dubs/d1/export')).toEqual([{ langs: ['ur'], default_lang: 'ur', subtitles: 'burn', include_original: true, stems: true }]),
    )
    expect(await within(drawer).findByText(/Exporting/)).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('tab', { name: 'Glossary' }))
    await user.type(screen.getByRole('textbox', { name: 'Term 1' }), 'Reef')
    await user.type(screen.getByRole('textbox', { name: 'Term 1 in Urdu' }), 'ریف')
    await user.click(screen.getByRole('button', { name: 'Save glossary' }))
    await waitFor(() => expect(sent(calls, 'PATCH', '/dubs/d1')).toEqual([{ glossary: [{ source: 'Reef', target: { ur: 'ریف' } }] }]))
  })

  it('jumps to a line from the timeline', async () => {
    api(translated())
    const user = userEvent.setup()
    renderAt('/audio/dub/d1', routes)
    const group = await screen.findByRole('group', { name: 'Segments on the timeline' })
    await user.click(within(group).getByRole('button', { name: 'Line 3 at 0:05.0' }))
    expect(screen.getByRole('listbox', { name: 'Lines, Urdu' })).toHaveAttribute('aria-activedescendant', 'dub-row-s3')
    expect(within(group).getByRole('button', { name: /Line 1 at 0:00.0, flagged/ })).toBeInTheDocument()
  })
})
