import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Script, ScriptLine } from '@/lib/dialogue'
import { stubMedia } from '@/test/audio-fixtures'
import { T, job, mockApi, renderAt } from '@/test/media-fixtures'
import { ENGINES, VOICES } from '@/test/voice-fixtures'
import { resetPlayer } from '../sharedAudio'
import { DialogueEditorPage } from './DialogueEditorPage'
import { DialogueListPage } from './DialogueListPage'

const routes = [
  { path: '/audio/dialogue', element: <DialogueListPage /> },
  { path: '/audio/dialogue/:id', element: <DialogueEditorPage /> },
]

const line = (id: string, text: string, extra: Partial<ScriptLine> = {}): ScriptLine => ({
  id,
  speaker_id: 'narrator',
  text,
  voice_id: null,
  speed: null,
  emotion: null,
  pause_after_s: null,
  para: false,
  status: 'empty',
  fingerprint: `fp-${id}`,
  ...extra,
})

const script = (lines: ScriptLine[], extra: Partial<Script> = {}): Script => ({
  id: 's1',
  title: 'Night train',
  language: 'en',
  engine: 'auto',
  project_id: null,
  cast: [
    { id: 'narrator', name: 'Narrator', voice_id: null, color: '#5B4630' },
    { id: 'c_maya', name: 'Maya', voice_id: null, color: '#2F5D62' },
  ],
  lines,
  settings: { gap_s: 0.35, paragraph_gap_s: 0.8, loudness: 'podcast', aerab: true },
  mix: null,
  mix_job: null,
  stems_job: null,
  counts: { lines: lines.length, ready: 0, stale: 0, empty: 0, rendering: 0, failed: 0 },
  created_at: T,
  updated_at: T,
  ...extra,
})

const THREE = [
  line('a', 'The rain had not stopped.', { status: 'ready', take_id: 'g1', take_url: '/media/a.flac', duration_s: 2 }),
  line('b', 'We should go.', { speaker_id: 'c_maya', status: 'stale', take_id: 'g2' }),
  line('c', 'Not yet.'),
]

function api(initial: Script) {
  let current = initial
  return mockApi((method, path, _q, body) => {
    const b = body as Record<string, unknown>
    if (path === '/voices/engines') return ENGINES
    if (path === '/voices') return VOICES
    if (path === '/jobs') return []
    if (path === '/projects') return [{ id: 'p1', title: 'Reef' }]
    if (path === '/projects/p1/scenes')
      return [
        { id: 'sc2', project_id: 'p1', order: 1, heading: 'INT. CABIN', script_text: 'TOMAS\nSleep.' },
        { id: 'sc1', project_id: 'p1', order: 0, heading: 'EXT. DECK', script_text: 'MAYA\nOne more dive.' },
      ]
    if (method === 'GET' && path === '/scripts') return [{ id: 's1', title: 'Night train', language: 'en', project_id: null, counts: { ...initial.counts, lines: 3, ready: 1, stale: 1, empty: 1 }, has_mix: false, created_at: T, updated_at: T }]
    if (method === 'POST' && path === '/scripts') return script([], { id: 's9', title: b.title as string })
    if (method === 'GET' && path === '/scripts/s1') return current
    if (method === 'PATCH' && path === '/scripts/s1') {
      const lines = (b.lines as ScriptLine[] | undefined)?.map((l) => ({ ...(current.lines.find((x) => x.id === l.id) ?? { status: 'empty' }), ...l })) ?? current.lines
      current = { ...current, ...b, lines } as Script
      return current
    }
    if (method === 'POST' && path === '/scripts/s1/render') return { jobs: [job('j1', { type: 'generate', lane: 'audio' })], queued: (b.line_ids as string[]).length, failed: 0 }
    if (method === 'POST' && path === '/scripts/s1/mix') return job('m1', { type: 'script_mix', status: 'queued' })
    if (method === 'POST' && path === '/scripts/s1/split') return { ...current, lines: [...current.lines, line('n1', 'Hello.')] }
    if (method === 'POST' && path === '/scripts/s1/import-project') return { ...current, lines: [...current.lines, line('i1', 'One more dive.')] }
    if (method === 'POST' && path === '/text/aerab') {
      const text = (b.text as string).replace('هذا سطر', 'هَذَا سَطْرٌ').replace('دل کی', 'دِل کی')
      return { text, marked: 1, kept: 0, low_coverage: 0, language: (b.language as string) ?? 'ur' }
    }
    if (path.startsWith('/favourites')) return { refs: [] }
  })
}

const posts = (calls: ReturnType<typeof api>, path: string) => calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body)
const texts = () => screen.getAllByRole('textbox', { name: /^Line \d+ text$/ }).map((t) => (t as HTMLTextAreaElement).value)

beforeEach(() => {
  stubMedia()
  resetPlayer()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Dialogue', () => {
  it('lists scripts and creates one', async () => {
    const calls = api(script(THREE))
    renderAt('/audio/dialogue', routes)
    const user = userEvent.setup()
    expect(await screen.findByRole('link', { name: 'Night train' })).toHaveAttribute('href', '/audio/dialogue/s1')
    expect(screen.getByText(/3 lines · 1 ready · 2 to render/)).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Lahore nights')
    await user.click(screen.getByRole('button', { name: 'New script' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/audio/dialogue/s9'))
    expect(posts(calls, '/scripts')).toEqual([{ title: 'Lahore nights', language: 'en' }])
  })

  it('renders only the changed lines', async () => {
    const calls = api(script(THREE))
    renderAt('/audio/dialogue/s1', routes)
    const user = userEvent.setup()
    const btn = await screen.findByRole('button', { name: 'Render 2 changed' })
    expect(screen.getByText('1 of 3 ready')).toBeInTheDocument()
    await user.click(btn)
    await waitFor(() => expect(posts(calls, '/scripts/s1/render')).toEqual([{ line_ids: ['b', 'c'] }]))
  })

  it('holds the mix until every line is ready and says why', async () => {
    const calls = api(script(THREE))
    renderAt('/audio/dialogue/s1', routes)
    const user = userEvent.setup()
    const mix = await screen.findByRole('button', { name: 'Mix' })
    expect(mix).toHaveAttribute('aria-disabled', 'true')
    expect(mix).toHaveAccessibleDescription('Mix: 2 lines to render first')
    await user.click(mix)
    expect(posts(calls, '/scripts/s1/mix')).toEqual([])
    cleanup()

    const ready = THREE.map((l) => ({ ...l, status: 'ready' as const, take_url: `/media/${l.id}.flac` }))
    const calls2 = api(script(ready, { mix: { media_id: 'mx', generation_id: 'gm', url: '/media/mx.flac', duration_s: 9, built_at: T, stale: false } }))
    renderAt('/audio/dialogue/s1', routes)
    const mix2 = await screen.findByRole('button', { name: 'Mix' })
    expect(mix2).not.toHaveAttribute('aria-disabled')
    await userEvent.setup().click(mix2)
    await waitFor(() => expect(posts(calls2, '/scripts/s1/mix')).toHaveLength(1))
    expect(screen.getByRole('link', { name: 'Open in Editor' })).toHaveAttribute('href', '/audio/edit/mx')
    expect(screen.getByRole('link', { name: 'Use in Score a Clip' })).toHaveAttribute('href', '/audio/score?audio=mx')
  })

  it('moves lines with the keyboard, saves the order, and undoes a delete', async () => {
    const calls = api(script(THREE))
    renderAt('/audio/dialogue/s1', routes)
    const user = userEvent.setup()
    const rows = await screen.findAllByRole('listitem', { name: /^Line \d/ })
    rows[0].focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(texts()).toEqual(['We should go.', 'The rain had not stopped.', 'Not yet.'])
    // focus follows the moved line
    expect(document.activeElement).toHaveAccessibleName(/^Line 2, Narrator/)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toHaveAccessibleName(/^Line 3, Narrator/)
    await waitFor(() => {
      const patches = calls.filter((c) => c.method === 'PATCH')
      expect((patches.at(-1)?.body as { lines: { id: string }[] } | undefined)?.lines.map((l) => l.id)).toEqual(['b', 'a', 'c'])
    })

    await user.keyboard('{Delete}')
    expect(texts()).toEqual(['We should go.', 'The rain had not stopped.'])
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(texts()).toEqual(['We should go.', 'The rain had not stopped.', 'Not yet.'])

    // Enter on a row starts a new line after it, with the caret in it
    screen.getAllByRole('listitem', { name: /^Line \d/ })[0].focus()
    await user.keyboard('{Enter}')
    expect(texts()).toEqual(['We should go.', '', 'The rain had not stopped.', 'Not yet.'])
    expect(document.activeElement).toHaveAccessibleName('Line 2 text')
    // an edit restales a ready line straight away
    const t = screen.getByRole('textbox', { name: 'Line 3 text' })
    await user.type(t, ' Again')
    expect(within(screen.getAllByRole('listitem', { name: /^Line 3/ })[0]).getByText('Changed')).toBeInTheDocument()
  })

  it('only mounts the rows on screen for a long script', async () => {
    api(script(Array.from({ length: 250 }, (_, i) => line(`l${i}`, `Line number ${i}.`))))
    renderAt('/audio/dialogue/s1', routes)
    const rows = await screen.findAllByRole('listitem', { name: /^Line \d/ })
    expect(rows.length).toBeLessThan(60)
    expect(screen.getByRole('button', { name: 'Render 250 changed' })).toBeInTheDocument()
    // End jumps to the last line and brings it into the window
    rows[0].focus()
    await userEvent.setup().keyboard('{End}')
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName(/^Line 250,/))
  })

  it('previews a paste and splits it on the server', async () => {
    const calls = api(script(THREE))
    renderAt('/audio/dialogue/s1', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Paste & split' }))
    const dialog = await screen.findByRole('dialog', { name: 'Paste & split' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Text' }), 'Maya: Run. Now!{Enter}Rafi: Wait.')
    const preview = within(dialog).getByRole('list', { name: 'Split preview' })
    expect(within(preview).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['MayaRun.', 'MayaNow!', 'RafiWait.'])
    expect(within(dialog).getByText('New in the cast: Rafi')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: 'Lines' }))
    expect(within(preview).getAllByRole('listitem')).toHaveLength(2)
    await user.click(within(dialog).getByRole('button', { name: 'Add 2 lines' }))
    await waitFor(() => expect(posts(calls, '/scripts/s1/split')).toEqual([{ text: 'Maya: Run. Now!\nRafi: Wait.', mode: 'lines', speaker_id: 'narrator' }]))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Paste & split' })).not.toBeInTheDocument())
  })

  it('adds aerab to one line or to all of them, with undo', async () => {
    const calls = api(script([line('a', 'هذا سطر'), line('b', 'Hello there.'), line('c', 'دل کی بات')], { language: 'ar' }))
    renderAt('/audio/dialogue/s1', routes)
    const user = userEvent.setup()
    // only lines in Arabic letters get the button
    expect(await screen.findByRole('button', { name: 'Add aerab to line 1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add aerab to line 2' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add aerab to line 3' }))
    await waitFor(() => expect(texts()).toEqual(['هذا سطر', 'Hello there.', 'دِل کی بات']))
    expect(posts(calls, '/text/aerab')[0]).toEqual({ text: 'دل کی بات', language: 'ar' })
    await user.click(screen.getByRole('button', { name: 'Undo aerab on line 3' }))
    expect(texts()).toEqual(['هذا سطر', 'Hello there.', 'دل کی بات'])

    await user.click(screen.getByRole('button', { name: /Add aerab to all lines/ }))
    await waitFor(() => expect(texts()).toEqual(['هَذَا سَطْرٌ', 'Hello there.', 'دِل کی بات']))
    expect(posts(calls, '/text/aerab')[1]).toEqual({ text: 'هذا سطر\nHello there.\nدل کی بات', language: 'ar' })
    // the edit is saved like any other
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body).includes('هَذَا سَطْرٌ'))).toBe(true))
    await user.click(screen.getAllByRole('button', { name: 'Undo aerab' })[0])
    expect(texts()).toEqual(['هذا سطر', 'Hello there.', 'دل کی بات'])
  })

  it('imports scenes from a film project', async () => {
    const calls = api(script(THREE))
    renderAt('/audio/dialogue/s1', routes)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Import from project' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import from a project' })
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Film project' }), 'p1')
    // scenes in script order
    const boxes = await within(dialog).findAllByRole('checkbox')
    expect(boxes.map((b) => b.closest('label')?.textContent)).toEqual(['1. EXT. DECK', '2. INT. CABIN'])
    await user.click(within(dialog).getByRole('switch', { name: /Include action lines/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Import all scenes' }))
    await waitFor(() => expect(posts(calls, '/scripts/s1/import-project')).toEqual([{ project_id: 'p1', include_action: true }]))

    await user.click(await screen.findByRole('button', { name: 'Import from project' }))
    const again = await screen.findByRole('dialog', { name: 'Import from a project' })
    await user.click((await within(again).findAllByRole('checkbox'))[1])
    await user.click(within(again).getByRole('button', { name: 'Import 1 scene' }))
    await waitFor(() => expect(posts(calls, '/scripts/s1/import-project').at(-1)).toEqual({ project_id: 'p1', scene_ids: ['sc1'], include_action: true }))
  })
})
