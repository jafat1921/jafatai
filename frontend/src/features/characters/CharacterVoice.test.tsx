import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import type { Character, TestClip, Voice } from '@/lib/types'
import type { GalleryVoice } from '@/lib/gallery'
import { CharacterPage } from './CharacterPage'

afterEach(() => vi.unstubAllGlobals())

const T = '2026-10-14T10:00:00Z'

const character = (extra: Partial<Character> = {}): Character => ({
  id: 'c1', project_id: null, name: 'Maya', description: 'a diver', source: 'user', locked: true,
  profile: { gender: 'female', age: '34', accent: 'British' }, voice_id: null, studio: true, films: [], ...extra,
})

const voice = (id: string, name: string, extra: Partial<Voice> = {}): Voice => ({
  id, name, language: 'en', notes: '', gender_hint: null, kind: 'preset', ref: null, ref_text: '', design: null,
  preset: { engine: 'kokoro', id: 'af_heart' }, portrait_url: null, starred: false, locked: false, consent: null,
  created_at: T, updated_at: T, uses: 0, ...extra,
})

const galleryVoice: GalleryVoice = {
  id: 'bm_george', voice_id: 'gallery:bm_george', name: 'George', language: 'en', languages: ['en'], gender: 'male',
  age: 'adult', accent: 'British', styles: ['calm'], engine: 'kokoro', kind: 'preset', preset: 'bm_george',
  sample_url: '/s.mp3', sample_ready: true, added_voice_id: null, starred: false,
}

function page(handler: (method: string, path: string, body: unknown) => unknown = () => undefined, who = character()) {
  const calls = mockApi((method, path, _q, body) => {
    const hit = handler(method, path, body)
    if (hit !== undefined) return hit
    if (path === '/characters/c1') return who
    if (path === '/voices') return [voice('v1', 'Heart')]
    if (path === '/voices/gallery') return { items: [galleryVoice], total: 1, facets: {} }
    if (path === '/characters/c1/test-clip') return { item: null, text: '' }
  })
  renderAt('/characters/c1', [{ path: '/characters/:characterId', element: <CharacterPage /> }])
  return { calls, user: userEvent.setup() }
}

describe('Character page: Voice tab', () => {
  it('offers my voices and the gallery, and saves the pick', async () => {
    const { calls, user } = page((method, path, body) => {
      if (method === 'PATCH' && path === '/characters/c1') return character({ voice_id: (body as { voice_id: string }).voice_id })
    })
    await user.click(await screen.findByRole('tab', { name: /Voice/ }))
    const pick = await screen.findByRole('combobox', { name: 'Voice' })
    await waitFor(() => expect(within(pick).getByRole('option', { name: 'George' })).toBeInTheDocument())
    expect(within(pick).getByRole('group', { name: 'My voices' })).toHaveTextContent('Heart')
    expect(within(pick).getByRole('group', { name: 'Gallery' })).toHaveTextContent('George')
    expect(screen.getByText(/lines use the video model's own audio/)).toBeInTheDocument()
    await user.selectOptions(pick, 'gallery:bm_george')
    await user.click(screen.getByRole('button', { name: 'Save voice' }))
    await waitFor(() => {
      const p = calls.find((c) => c.method === 'PATCH' && c.path === '/characters/c1')
      expect(p?.body).toEqual({ voice_id: 'gallery:bm_george' })
    })
    expect(screen.getByRole('link', { name: 'Voices' })).toHaveAttribute('href', '/audio/voices')
  })

  it('previews a line in the picked voice and plays it when ready', async () => {
    const { calls, user } = page((method, path) => {
      if (method === 'POST' && path === '/audio/speak') return { items: [media('a1', { kind: 'audio', status: 'queued' })], jobs: [] }
      if (path === '/media/a1') return media('a1', { kind: 'audio', status: 'ready', media_url: '/m/a1.flac' })
    }, character({ voice_id: 'v1' }))
    await user.click(await screen.findByRole('tab', { name: /Voice/ }))
    await user.click(await screen.findByRole('button', { name: 'Preview' }))
    await waitFor(() => {
      const p = calls.find((c) => c.method === 'POST' && c.path === '/audio/speak')
      expect(p?.body).toMatchObject({ text: 'Hello, my name is Maya.', voice_id: 'v1', language: 'en' })
    })
    expect(await screen.findByLabelText('Preview of Heart')).toHaveAttribute('src', '/m/a1.flac')
  })

  it('designs a voice from the profile', async () => {
    const designed = voice('v9', "Maya's voice", { kind: 'design', preset: null })
    const { calls, user } = page((method, path) => {
      if (method === 'POST' && path === '/characters/c1/voice/design') {
        return { character: character({ voice_id: 'v9' }), voice: designed, description: 'female, young adult, British accent',
          understood: ['female', 'young adult', 'british accent'], ignored: ['warm'] }
      }
    })
    await user.click(await screen.findByRole('tab', { name: /Voice/ }))
    expect(await screen.findByText(/Made from the profile: female, age 34, British accent/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Anything to add (optional)'), 'warm')
    await user.click(screen.getByRole('button', { name: 'Design voice' }))
    await waitFor(() => {
      const p = calls.find((c) => c.method === 'POST' && c.path === '/characters/c1/voice/design')
      expect(p?.body).toEqual({ extra: 'warm' })
    })
    expect(await screen.findByText(/can't use “warm”/)).toBeInTheDocument()
  })
})

describe('Character page: Test clip tab', () => {
  const ready: TestClip = {
    item: media('v1', { kind: 'video', status: 'ready', media_url: '/m/clip.mp4', generation_id: 'g-clip' }),
    text: 'Hello there.', panel: 'closeup',
  }

  it('asks for a voice first', async () => {
    const { user } = page()
    await user.click(await screen.findByRole('tab', { name: /Test clip/ }))
    expect(await screen.findByText(/has no voice yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make test clip' })).toBeDisabled()
  })

  it('makes a clip from a typed line, then plays and downloads it', async () => {
    const { calls, user } = page((method, path) => {
      if (method === 'POST' && path === '/characters/c1/test-clip') return ready
    }, character({ voice_id: 'v1' }))
    await user.click(await screen.findByRole('tab', { name: /Test clip/ }))
    const line = await screen.findByRole('textbox', { name: 'Line' })
    await user.type(line, 'Hello there.')
    expect(screen.getByText('2 of 23 words')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Make test clip' }))
    await waitFor(() => {
      const p = calls.find((c) => c.method === 'POST' && c.path === '/characters/c1/test-clip')
      expect(p?.body).toEqual({ text: 'Hello there.' })
    })
    expect(await screen.findByLabelText(/Test clip: Maya saying/)).toHaveAttribute('src', '/m/clip.mp4')
    expect(screen.getByRole('link', { name: 'Download clip' })).toHaveAttribute('href', '/api/generations/g-clip/download')
  })

  it('stops a line too long for ten seconds', async () => {
    const { user } = page(undefined, character({ voice_id: 'v1' }))
    await user.click(await screen.findByRole('tab', { name: /Test clip/ }))
    await user.type(await screen.findByRole('textbox', { name: 'Line' }), Array(24).fill('word').join(' '))
    expect(screen.getByText(/too long for a 10-second clip/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Make test clip' })).toBeDisabled()
  })
})
