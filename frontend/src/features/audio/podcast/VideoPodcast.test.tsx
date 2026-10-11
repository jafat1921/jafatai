import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Episode } from '@/lib/podcast'
import type { Generation, VideoPodcast, VPShot, VPStageKey, VPStageStatus } from '@/lib/types'
import { T, job, media, mockApi, renderAt } from '@/test/media-fixtures'
import { EpisodePage } from './EpisodePage'
import { VideoPodcastPage } from './video/VideoPodcastPage'
import { LIKENESS_STATEMENT } from './video/vp'

const routes = [
  { path: '/audio/podcast/:id', element: <EpisodePage /> },
  { path: '/audio/podcast/:id/video', element: <VideoPodcastPage /> },
]

const MIX = {
  media_id: 'mx',
  generation_id: 'gm',
  url: '/m/mix.flac',
  duration_s: 12,
  built_at: T,
  stale: false,
  timeline: [],
  chapters: [{ id: 'c1', title: 'Hello', start: 0, end: 12 }],
}

const episode = (extra: Partial<Episode> = {}): Episode => ({
  id: 'e1',
  show_id: null,
  show_name: null,
  title: 'Bridge day',
  format: 'conversation',
  language: 'en',
  target_minutes: 5,
  step: 6,
  cover_media_id: null,
  cover_url: null,
  sources: { topic: 'A new bridge', text: '', docs: [], has_script: true },
  hosts: [
    { id: 'h1', name: 'Ali', role: 'host', persona: 'curious', voice_id: null, me: false },
    { id: 'h2', name: 'Sara', role: 'cohost', persona: 'dry wit', voice_id: null, me: false },
  ],
  chapters: [{ id: 'c1', title: 'Hello' }],
  script_id: 's1',
  settings: {
    intro: { media_id: null, lead_s: 4, overlap_s: 3, gain_db: 0 },
    outro: { media_id: null, overlap_s: 2, gain_db: 0, max_s: 30 },
    bed: { media_id: null, gain_db: -20 },
    duck_db: 12,
    gap_s: 0.35,
    chapter_gap_s: 1,
    loudness: 'stereo',
  },
  notes: null,
  outputs: { mix: MIX, publish: null, video: null },
  jobs: {},
  words: 15,
  minutes: 0.2,
  counts: { lines: 2, ready: 2, stale: 0, empty: 0, rendering: 0, failed: 0 },
  created_at: T,
  updated_at: T,
  ...extra,
})

const gen = (id: string, extra: Partial<Generation> = {}): Generation => ({
  id,
  target_type: 'character',
  target_id: 't',
  kind: 'portrait',
  version: 1,
  status: 'ready',
  prompt: '',
  params: {},
  seed: 1,
  media_url: `/m/${id}.png`,
  created_at: T,
  ...extra,
})

const shot = (id: string, start: number, end: number, extra: Partial<VPShot> = {}): VPShot => ({
  id,
  type: 'lipsync',
  angle: 'h1:close',
  speaker_id: 'h1',
  line_id: 'l1',
  start,
  end,
  duration: end - start,
  chapter_id: 'c1',
  text: 'Welcome to the show.',
  lipsync: true,
  marked: false,
  takes: { draft: null, final: null },
  needs: { draft: true, final: true },
  thumb_url: '/m/a1.png',
  ...extra,
})

const STAGES: [VPStageKey, string][] = [
  ['cast', 'Hosts'],
  ['set', 'Set'],
  ['keyframes', 'Look'],
  ['plan', 'Shots'],
  ['render', 'Render'],
  ['assemble', 'Assemble'],
]

const vpOf = (stage: VPStageKey, extra: Partial<VideoPodcast> = {}): VideoPodcast => {
  const at = STAGES.findIndex(([k]) => k === stage)
  return {
    id: 'v1',
    episode_id: 'e1',
    project_id: 'p1',
    title: 'Bridge day',
    language: 'en',
    stage,
    status: 'idle',
    review: null,
    stages: STAGES.map(([key, label], i) => ({
      key,
      label,
      status: (i < at ? 'done' : 'pending') as VPStageStatus,
      detail: null,
      started_at: null,
      finished_at: null,
    })),
    settings: { aspect: '16:9', style: 'realistic studio', subtitles: 'none', set_preset: 'modern_studio', set_prompt: '', cover_intro: false, cover_outro: false, cover_media_id: null },
    hosts: [
      { host_id: 'h1', name: 'Ali', role: 'host', persona: 'curious', source: 'persona', character_id: 'c1', photo_media_id: null, photo_url: null, from_character_id: null, consent: null, portrait: gen('gp1'), sheet_views: {} },
      { host_id: 'h2', name: 'Sara', role: 'cohost', persona: 'dry wit', source: 'persona', character_id: 'c2', photo_media_id: null, photo_url: null, from_character_id: null, consent: null, portrait: null, sheet_views: {} },
    ],
    set: { location_id: null, preset: 'modern_studio', prompt: '', description: '', establishing: null },
    angles: [
      { key: 'h1:close', label: 'Close-up', host_id: 'h1', shot_id: 'k1', frame: gen('a1') },
      { key: 'h1:three_quarter', label: '3/4 close-up', host_id: 'h1', shot_id: 'k2', frame: gen('a2') },
      { key: 'h2:listen', label: 'Listening', host_id: 'h2', shot_id: 'k3', frame: gen('a3') },
      { key: 'wide', label: 'Wide', host_id: null, shot_id: 'k4', frame: gen('a4') },
      { key: 'medium', label: 'Two-shot', host_id: null, shot_id: 'k5', frame: gen('a5') },
    ],
    plan: [shot('s1', 0, 2, { type: 'wide', angle: 'wide', speaker_id: null, line_id: null, text: '' }), shot('s2', 2, 8), shot('s3', 8, 12, { angle: 'h1:three_quarter' })],
    plan_stats: { shots: 3, lipsync: 2, reaction: 0, wide: 1, medium: 0, cover: 0, seconds: 12 },
    duration_s: 12,
    mix_stale: false,
    outputs: { draft: null, final: null },
    job: null,
    eta_s: null,
    created_at: T,
    updated_at: T,
    ...extra,
  }
}

const NOT_FOUND = () => new Response(JSON.stringify({ detail: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })

function api(vp: VideoPodcast | null, ep: Episode = episode()) {
  return mockApi((method, path) => {
    if (path === '/jobs') return []
    if (path.startsWith('/favourites')) return { refs: [] }
    if (path === '/media') return { items: [media('p1', { title: 'Ali at the desk' })] }
    if (path === '/podcast/episodes/e1') return ep
    if (path === '/podcast/episodes/e1/ai-video') {
      if (method === 'POST') return vpOf('cast')
      return vp ?? NOT_FOUND()
    }
    if (path === '/podcast/ai-video/v1') return vp
    if (path === '/podcast/ai-video/v1/characters') return [{ id: 'x1', name: 'Inspector Rafi', description: 'tall, grey moustache', project_id: 'pp', project_title: 'Harbour', portrait_url: '/m/x1.png' }]
    if (path === '/podcast/ai-video/v1/estimate') return { quality: 'draft', shots: 3, seconds: 12, low_s: 1800, high_s: 3600, basis: 'measured', label: '≈ 0.8 h on the video GPU' }
    if (path === '/podcast/ai-video/v1/continue') return job('j1', { type: 'video_podcast' })
    if (path === '/podcast/ai-video/v1/regenerate') return gen('gp2', { status: 'queued' })
    if (path.startsWith('/generations/')) return gen('gp1', { status: 'approved' })
    if (path === '/podcast/ai-video/v1/render') return job('j2', { type: 'video_podcast' })
    if (path === '/podcast/ai-video/v1/assemble') return job('j3', { type: 'video_podcast_assemble' })
    if (path.startsWith('/podcast/ai-video/v1')) return vp
  })
}

const sent = (calls: ReturnType<typeof api>, method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).map((c) => c.body)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AI video podcast', { timeout: 20_000 }, () => {
  it('moves through the steps with the keyboard and starts the stage', async () => {
    const calls = api(vpOf('cast'))
    renderAt('/audio/podcast/e1/video', routes)
    const user = userEvent.setup()
    const hosts = await screen.findByRole('tab', { name: /Hosts/ })
    expect(hosts).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('link', { name: /Back to the episode/ })).toHaveAttribute('href', '/audio/podcast/e1')
    expect(screen.getByRole('list', { name: 'Progress' })).toHaveTextContent('Hosts')
    hosts.focus()
    await user.keyboard('{ArrowRight}')
    const set = screen.getByRole('tab', { name: /Set/ })
    expect(set).toHaveAttribute('aria-selected', 'true')
    expect(set).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'Set', level: 2 })).toBeInTheDocument()
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: /Result/ })).toHaveFocus()
    expect(screen.getByText('Nothing cut yet')).toBeInTheDocument()
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: /Hosts/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: /Make the portraits/ }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/continue')).toHaveLength(1))
  })

  it('continues from a review stop', async () => {
    const vp = vpOf('cast', { review: 'hosts', status: 'review' })
    vp.stages[0].status = 'review'
    const calls = api(vp)
    renderAt('/audio/podcast/e1/video', routes)
    const user = userEvent.setup()
    const banner = await screen.findByRole('region', { name: 'Waiting for your review' })
    expect(screen.queryByRole('button', { name: /Make the portraits/ })).not.toBeInTheDocument()
    await user.click(within(banner).getByRole('button', { name: /Continue/ }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/continue')).toHaveLength(1))
  })

  it('needs a name and the consent tick before a photo is used', async () => {
    const calls = api(vpOf('cast'))
    renderAt('/audio/podcast/e1/video', routes)
    const user = userEvent.setup()
    const ali = (await screen.findByRole('heading', { name: 'Ali' })).closest('li')!
    await user.click(within(ali).getByRole('radio', { name: 'Upload photo' }))
    await user.click(within(ali).getByRole('button', { name: 'Pick from Library' }))
    const dialog = screen.getByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: /Ali at the desk/ }))
    await user.click(within(dialog).getByRole('button', { name: /Use selected/ }))
    const use = within(ali).getByRole('button', { name: 'Use this photo' })
    await user.click(use)
    expect(within(ali).getByText("Type the person's name.")).toBeInTheDocument()
    await user.type(within(ali).getByRole('textbox', { name: "Person's name" }), 'Ali Raza')
    await user.click(use)
    expect(within(ali).getByText('Tick the consent statement to use this photo.')).toBeInTheDocument()
    expect(sent(calls, 'PATCH', '/podcast/ai-video/v1')).toEqual([])
    await user.click(within(ali).getByRole('checkbox', { name: LIKENESS_STATEMENT }))
    await user.click(use)
    await waitFor(() =>
      expect(sent(calls, 'PATCH', '/podcast/ai-video/v1')).toEqual([
        { hosts: { h1: { source: 'photo', media_id: 'p1', consent: { name: 'Ali Raza', statement: LIKENESS_STATEMENT } } } },
      ]),
    )
  })

  it('uses an existing character, regenerates and approves a portrait', async () => {
    const calls = api(vpOf('cast'))
    renderAt('/audio/podcast/e1/video', routes)
    const user = userEvent.setup()
    const sara = (await screen.findByRole('heading', { name: 'Sara' })).closest('li')!
    await user.click(within(sara).getByRole('radio', { name: 'Use existing character' }))
    await user.click(within(sara).getByRole('button', { name: 'Pick a character' }))
    await user.click(await within(screen.getByRole('dialog')).findByRole('button', { name: /Inspector Rafi/ }))
    await waitFor(() => expect(sent(calls, 'PATCH', '/podcast/ai-video/v1')).toEqual([{ hosts: { h2: { source: 'existing', character_id: 'x1' } } }]))
    await user.click(screen.getByRole('button', { name: 'Regenerate portrait of Ali' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/regenerate')).toEqual([{ what: 'portrait', key: 'h1' }]))
    await user.click(screen.getByRole('button', { name: 'Approve portrait of Ali' }))
    await waitFor(() => expect(sent(calls, 'POST', '/generations/gp1/approve')).toHaveLength(1))
    // Sara has no portrait yet, so nothing to approve
    expect(screen.queryByRole('button', { name: 'Approve portrait of Sara' })).not.toBeInTheDocument()
  })

  it('sets the set preset and the shape', async () => {
    const calls = api(vpOf('set'))
    renderAt('/audio/podcast/e1/video', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Desi baithak' }))
    await user.click(screen.getByRole('radio', { name: /9:16/ }))
    await waitFor(() => expect(sent(calls, 'PATCH', '/podcast/ai-video/v1')).toEqual([{ settings: { set_preset: 'desi_baithak' } }, { settings: { aspect: '9:16' } }]))
    await user.click(screen.getByRole('button', { name: 'Regenerate the set' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/regenerate')).toEqual([{ what: 'set' }]))
  })

  it('edits the plan: type, split, merge, and replan after a confirm', async () => {
    const calls = api(vpOf('render'))
    renderAt('/audio/podcast/e1/video', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: /Shots/ }))
    expect(screen.getByText(/3 shots · 2 lip-sync/)).toBeInTheDocument()

    const timeline = screen.getByRole('group', { name: 'Shot timeline' })
    const first = within(timeline).getByRole('button', { name: /Shot 1: Wide/ })
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(within(timeline).getByRole('button', { name: /Shot 2:/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('combobox', { name: 'Shot 2 type' })).toHaveFocus()

    // a reaction can only use a listening angle
    await user.selectOptions(screen.getByRole('combobox', { name: 'Shot 2 type' }), 'reaction')
    await waitFor(() => expect(sent(calls, 'PATCH', '/podcast/ai-video/v1/shots/s2')).toEqual([{ type: 'reaction', angle: 'h2:listen' }]))
    await user.click(screen.getByRole('button', { name: 'Split shot 3' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/shots/s3/split')).toEqual([{}]))
    await user.click(screen.getByRole('button', { name: 'Merge shot 1 with the next' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/shots/merge')).toEqual([{ shot_ids: ['s1', 's2'] }]))
    expect(screen.getByRole('button', { name: 'Merge shot 3 with the next' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'Render shot 2 again next time' }))
    await waitFor(() => expect(sent(calls, 'PATCH', '/podcast/ai-video/v1/shots/s2')).toContainEqual({ marked: true }))

    await user.click(screen.getByRole('button', { name: 'Replan' }))
    expect(sent(calls, 'POST', '/podcast/ai-video/v1/replan')).toEqual([])
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Replan' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/replan')).toHaveLength(1))
  })

  it('shows the estimate before rendering, then renders and re-renders one shot', async () => {
    const calls = api(vpOf('render'))
    renderAt('/audio/podcast/e1/video', routes)
    const user = userEvent.setup()
    expect(await screen.findByText('≈ 0.8 h on the video GPU')).toBeInTheDocument()
    expect(screen.getByText(/3 shots to render/)).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/podcast/ai-video/v1/estimate')?.query).toEqual({ quality: 'draft' })
    expect(sent(calls, 'POST', '/podcast/ai-video/v1/render')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Render draft' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/render')).toEqual([{ quality: 'draft' }]))
    await user.click(screen.getByRole('button', { name: 'Re-render shot 2' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/render')).toContainEqual({ quality: 'draft', shot_ids: ['s2'] }))
  })

  it('locks the actions while a job runs', async () => {
    api(vpOf('render', { status: 'running', job: job('j9', { type: 'video_podcast', status: 'running', message: 'Rendering shot 2 of 3' }) }))
    renderAt('/audio/podcast/e1/video', routes)
    expect(await screen.findByText('Rendering shot 2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Render draft' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Re-render shot 1' })).toBeDisabled()
  })

  it('plays the result and cuts again with burned subtitles', async () => {
    const out = {
      media_id: 'mv',
      generation_id: 'gv',
      url: '/m/draft.mp4',
      quality: 'draft' as const,
      duration_s: 12,
      built_at: T,
      subtitles: 'none' as const,
      renderer: 'ffmpeg',
      fonts_missing: ['Noto Nastaliq Urdu'],
      fallback_shots: [],
      width: 832,
      height: 480,
    }
    const vp = vpOf('assemble', { stage: 'done', outputs: { draft: out, final: null } })
    const calls = api(vp)
    renderAt('/audio/podcast/e1/video', routes)
    const user = userEvent.setup()
    expect(await screen.findByLabelText('Bridge day, draft')).toHaveAttribute('src', '/m/draft.mp4')
    expect(screen.getByRole('link', { name: 'Open in Library' })).toHaveAttribute('href', '/video/library?open=mv')
    expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('href', '/m/draft.mp4')
    expect(screen.getByText(/lacks fonts for Noto Nastaliq Urdu/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Burned in' }))
    await user.click(screen.getByRole('button', { name: 'Cut the draft again' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/ai-video/v1/assemble')).toEqual([{ quality: 'draft' }]))
    expect(sent(calls, 'PATCH', '/podcast/ai-video/v1')).toEqual([{ settings: { subtitles: 'burn', cover_intro: false, cover_outro: false } }])
  })
})

describe('Publish: AI video entry', { timeout: 20_000 }, () => {
  it('makes the AI video and opens it', async () => {
    const calls = api(null)
    renderAt('/audio/podcast/e1', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Make an AI video' }))
    await waitFor(() => expect(sent(calls, 'POST', '/podcast/episodes/e1/ai-video')).toEqual([{}]))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/audio/podcast/e1/video'))
    expect(await screen.findByRole('tab', { name: /Hosts/ })).toBeInTheDocument()
  })

  it('opens the one there is', async () => {
    const calls = api(vpOf('plan'))
    renderAt('/audio/podcast/e1', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Open AI video' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/audio/podcast/e1/video'))
    expect(sent(calls, 'POST', '/podcast/episodes/e1/ai-video')).toEqual([])
  })

  it('waits for the mix', async () => {
    const calls = api(null, episode({ outputs: { mix: null, publish: null, video: null } }))
    renderAt('/audio/podcast/e1', routes)
    const user = userEvent.setup()
    const make = await screen.findByRole('button', { name: 'Make an AI video' })
    expect(make).toHaveAttribute('aria-disabled', 'true')
    expect(make).toHaveAccessibleDescription('Mix the episode first (step 5).')
    await user.click(make)
    expect(sent(calls, 'POST', '/podcast/episodes/e1/ai-video')).toEqual([])
  })
})
