import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import type { Character, CharacterSheet, Generation, SheetCatalogue, SheetPanel, Shot } from '@/lib/types'
import { RefsStrip } from '@/features/storyboard/RefsStrip'
import { CharacterPage } from './CharacterPage'
import { CharacterStudioPage } from './CharacterStudioPage'
import { countPanels } from './sheet'

afterEach(() => vi.unstubAllGlobals())

const CAT: SheetCatalogue = {
  sections: [],
  counts: { turnaround: [0, 4], motion: [0, 1], head: [0, 5, 15], expressions: [0, 4, 8], closeup: [0, 1], gestures: [0, 1, 2, 3, 4], postures: [0, 1, 2, 3] },
  lists: { outfits: 3, details: 4, props: 3, accessories: 6 },
  presets: {
    essential: { counts: { turnaround: 4, expressions: 4, closeup: 1 }, panels: 10 },
    full: { counts: { turnaround: 4, motion: 1, head: 15, expressions: 8, closeup: 1 }, panels: 30 },
  },
  backdrops: ['grey', 'dark'],
  seconds_per_panel: [20, 40],
}

const gen = (id: string, panel: string, status: Generation['status'] = 'ready'): Generation => ({
  id, target_type: 'character', target_id: 'c1', kind: 'sheet_view', version: 1, status, prompt: '', params: { panel },
  seed: 1, media_url: `/m/${id}.png`, thumb_url: `/t/${id}.webp`, created_at: '2026-10-14T10:00:00Z',
})

const panel = (key: string, section: string, title: string, label: string, status: SheetPanel['status'] = 'ready'): SheetPanel => ({
  key, section, section_title: title, label, default_label: label, source: 'portrait', status,
  current: status === 'ready' ? gen(`g-${key}`, key) : null, live_job_id: null, versions: status === 'ready' ? 1 : 0, stale: false,
})

const character = (extra: Partial<Character> = {}): Character => ({
  id: 'c1', project_id: null, name: 'Maya', description: 'a diver in a yellow raincoat', source: 'user', locked: true,
  profile: { role: 'Marine biologist' }, voice_id: null, studio: true, approved_portrait: null, portrait: null,
  panels_ready: 2, films: [{ id: 'p1', title: 'Reef' }, { id: 'p2', title: 'Harbour' }], ...extra,
})

const sheet = (extra: Partial<CharacterSheet> = {}): CharacterSheet => ({
  character_id: 'c1', preset: 'essential', counts: {}, lists: {}, backdrop: 'grey', titles: {}, footer: {}, ruler: false,
  panels: [
    panel('hero', 'hero', 'Hero', 'Full body'),
    panel('turn_front', 'turnaround', 'Turnaround', 'Front'),
    panel('turn_back', 'turnaround', 'Turnaround', 'Back', 'waiting'),
    panel('expr_smile', 'expressions', 'تاثرات', 'مسکراہٹ'),
  ],
  palette: ['#c8a040', '#203050'], estimate: { panels: 1, seconds_low: 20, seconds_high: 40 }, has_portrait: true,
  board: { media_id: null, layout: 'dossier', generation: null, status: 'none' }, ...extra,
})

function page(handler: (method: string, path: string, body: unknown) => unknown = () => undefined) {
  const calls = mockApi((method, path, _q, body) => {
    const hit = handler(method, path, body)
    if (hit !== undefined) return hit
    if (path === '/characters/c1') return character()
    if (path === '/characters/c1/sheet') return sheet()
    if (path === '/character-sheet/catalogue') return CAT
    if (path === '/voices' || path === '/voices/gallery') return []
  })
  const r = renderAt('/characters/c1', [
    { path: '/characters/:characterId', element: <CharacterPage /> },
    { path: '/characters', element: <p>studio list</p> },
  ])
  return { ...r, calls, user: userEvent.setup() }
}

describe('sheet panel counts', () => {
  it('adds up the presets the way the server does', () => {
    expect(countPanels(CAT, 'essential', {}, { props: ['x'] })).toBe(10)
    expect(countPanels(CAT, 'full', {}, {})).toBe(30)
    expect(countPanels(CAT, 'full', {}, { props: ['a', 'b', 'c', 'd'], accessories: ['w', ' '] })).toBe(34)
    expect(countPanels(CAT, 'custom', { head: 5, gestures: 2 }, { outfits: ['field ops'] })).toBe(9)
  })
})

describe('Character Studio', () => {
  it('lists the library and searches it', async () => {
    const calls = mockApi((_m, path) => {
      if (path === '/characters') return [character(), character({ id: 'c2', name: 'Rafi', films: [], panels_ready: 0 })]
    })
    const user = userEvent.setup()
    renderAt('/characters', [{ path: '/characters', element: <CharacterStudioPage /> }])
    const list = await screen.findByRole('list', { name: 'Characters' })
    expect(within(list).getByRole('link', { name: 'Open Maya' })).toHaveAttribute('href', '/characters/c1')
    expect(within(list).getByText('2 sheet panels · in 2 films')).toBeInTheDocument()
    expect(within(list).getByText('No sheet yet')).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Search characters' }), 'raf')
    await waitFor(() => expect(calls.some((c) => c.path === '/characters' && c.query.q === 'raf')).toBe(true))
  })
})

describe('Character page: Sheet tab', () => {
  it('shows panels by section, with Urdu titles and a live estimate, and makes a Full sheet', async () => {
    const { calls, user } = page((method, path) => {
      if (method === 'POST' && path === '/characters/c1/sheet') return { ...sheet({ preset: 'full' }), queued: 20 }
    })
    await user.click(await screen.findByRole('tab', { name: /Sheet/ }))
    expect(await screen.findByRole('region', { name: 'Turnaround' })).toBeInTheDocument()
    const expr = screen.getByRole('region', { name: 'تاثرات' })
    expect(within(expr).getByRole('button', { name: 'Review مسکراہٹ' })).toBeInTheDocument()
    expect(screen.getByText('Waits for the full body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate Back' })).toBeDisabled()
    expect(screen.getByText(/10 panels · about 3–7 min/)).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Full' }))
    expect(screen.getByText(/30 panels · about 10–20 min/)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Props & weapons/), 'Brass compass')
    expect(screen.getByText(/31 panels/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    await user.click(screen.getByRole('button', { name: 'Make sheet' }))
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/characters/c1/sheet')
      expect(post?.body).toMatchObject({ preset: 'full', backdrop: 'dark', lists: { props: ['Brass compass'] } })
    })
  })

  it('regenerates a single panel', async () => {
    const { calls, user } = page((method, path) => {
      if (method === 'POST' && path === '/characters/c1/sheet/panels/turn_front/regenerate') return { ...gen('g2', 'turn_front', 'queued'), version: 2 }
    })
    await user.click(await screen.findByRole('tab', { name: /Sheet/ }))
    await user.click(await screen.findByRole('button', { name: 'Regenerate Front' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/panels/turn_front/regenerate'))).toBe(true))
  })

  it('asks for a portrait before a sheet', async () => {
    const { user } = page((_m, path) => (path === '/characters/c1/sheet' ? sheet({ has_portrait: false, panels: [] }) : undefined))
    await user.click(await screen.findByRole('tab', { name: /Sheet/ }))
    expect(await screen.findByRole('button', { name: 'Make sheet' })).toBeDisabled()
    expect(screen.getByText(/Make and approve a portrait first/)).toBeInTheDocument()
    expect(screen.getByText('No panels yet')).toBeInTheDocument()
  })
})

describe('Character page: Profile', () => {
  it('saves the profile with cleared fields sent blank', async () => {
    const { calls, user } = page((method, path, body) => {
      if (method === 'PATCH' && path === '/characters/c1') return character({ profile: (body as { profile: object }).profile })
    })
    const role = await screen.findByLabelText('Role')
    expect(role).toHaveValue('Marine biologist')
    await user.clear(role)
    await user.type(screen.getByLabelText('Height'), '172 cm')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => {
      const p = calls.find((c) => c.method === 'PATCH' && c.path === '/characters/c1')
      expect(p?.body).toMatchObject({ name: 'Maya', profile: { role: '', height: '172 cm' } })
    })
  })

  it('fills from the description through an AI job', async () => {
    const { calls, user } = page((method, path) => {
      if (method === 'POST' && path === '/characters/c1/ai/profile') return { id: 'j1', type: 'ai_character_profile', status: 'queued', progress: 0, message: '' }
    })
    await user.click(await screen.findByRole('button', { name: 'Fill from description' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/characters/c1/ai/profile')).toBe(true))
  })

  it('names the films before deleting everywhere', async () => {
    const { calls, user } = page((method) => (method === 'DELETE' ? new Response(null, { status: 204 }) : undefined))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/“Reef”, “Harbour”/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Delete everywhere' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/characters/c1' && !c.query.project_id)).toBe(true))
  })
})

describe('References strip', () => {
  it('shows the chosen panel and lets the user swap it', async () => {
    const shot = { id: 's1', project_id: 'p1', updated_at: '2026-10-14T10:00:00Z', character_ids: ['c1'] } as unknown as Shot
    const calls = mockApi((method, path) => {
      if (path === '/shots/s1/refs') {
        return {
          max_refs: 3,
          refs: [{ kind: 'character', id: 'c1', name: 'Maya', panel: 'turn_front', panel_label: 'Front', auto: true,
            generation: gen('g-turn_front', 'turn_front'), used: true,
            options: [{ key: 'portrait', label: 'Portrait', section_title: 'Portrait' }, { key: 'turn_back', label: 'Back', section_title: 'Turnaround' }] }],
        }
      }
      if (method === 'PATCH' && path === '/shots/s1') return { ...shot, ref_panels: { c1: 'turn_back' } }
    })
    const user = userEvent.setup()
    renderAt('/x', [{ path: '/x', element: <RefsStrip shot={shot} /> }])
    const pick = await screen.findByRole('combobox', { name: 'Reference picture for Maya' })
    expect(pick).toHaveValue('auto')
    expect(screen.getByRole('option', { name: 'Auto: Front' })).toBeInTheDocument()
    await user.selectOptions(pick, 'turn_back')
    await waitFor(() => {
      const p = calls.find((c) => c.method === 'PATCH' && c.path === '/shots/s1')
      expect(p?.body).toEqual({ ref_panels: { c1: 'turn_back' } })
    })
  })
})
