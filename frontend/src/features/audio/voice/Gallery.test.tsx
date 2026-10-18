import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { galleryAsVoice, initialsOf, isGalleryId, matchesGallery, type GalleryResponse, type GalleryVoice } from '@/lib/gallery'
import { audioItem, stubMedia } from '@/test/audio-fixtures'
import { openChip } from '@/test/dock'
import { job, mockApi, renderAt } from '@/test/media-fixtures'
import { ENGINES, VOICES, voice } from '@/test/voice-fixtures'
import { resetPlayer, usePlayer } from '../sharedAudio'
import { GalleryPage } from './GalleryPage'
import { SpeakPage } from './SpeakPage'

const gv = (id: string, extra: Partial<GalleryVoice> = {}): GalleryVoice => ({
  id,
  voice_id: `gallery:${id}`,
  name: `Voice ${id}`,
  language: 'en',
  languages: ['en'],
  gender: 'female',
  age: 'adult',
  accent: 'American',
  styles: ['calm'],
  engine: 'omnivoice',
  kind: 'design',
  instruct: 'female, middle-aged',
  seed: 1,
  sample_url: `/api/voices/gallery/${id}/sample`,
  sample_ready: false,
  added_voice_id: null,
  starred: false,
  ...extra,
})

const GALLERY: GalleryVoice[] = [
  gv('ur-dadi', { name: 'Dadi Amma, grandmother', language: 'ur', languages: ['ur'], age: 'elder', accent: 'Urdu', styles: ['storyteller', 'warm'] }),
  gv('ur-lahore-narrator', { name: 'Aamir, Lahore narrator', language: 'ur', languages: ['ur'], gender: 'male', accent: 'Lahori Urdu', styles: ['narrator'], sample_ready: true }),
  gv('af_heart', { name: 'Heart', engine: 'kokoro', kind: 'preset', instruct: undefined, seed: undefined, preset: 'af_heart', age: 'young', styles: ['warm'] }),
  gv('en-uk-news', { name: 'Charlotte, UK newsreader', accent: 'British RP', styles: ['news'], added_voice_id: 'v7', starred: true }),
]

const facet = (value: string, label: string, count: number) => ({ value, label, count })

function response(items: GalleryVoice[]): GalleryResponse {
  return {
    items,
    total: items.length,
    facets: {
      language: [facet('en', 'English', 2), facet('ur', 'Urdu', 2)],
      gender: [facet('female', 'Female', 3), facet('male', 'Male', 1)],
      age: [facet('adult', 'Adult', 2), facet('elder', 'Elder', 1), facet('young', 'Young', 1)],
      style: [facet('warm', 'Warm', 2), facet('narrator', 'Narrator', 1)],
      engine: [facet('omnivoice', 'OmniVoice', 3), facet('kokoro', 'Kokoro', 1)],
    },
  }
}

interface Opts {
  // how many 202s the sample answers before the file is there
  preparing?: number
}

function api(opts: Opts = {}) {
  let waits = opts.preparing ?? 0
  return mockApi((method, path, q, body) => {
    const b = body as Record<string, unknown>
    if (path === '/voices/engines') return ENGINES
    if (method === 'GET' && path === '/voices') return VOICES
    if (method === 'GET' && path === '/voices/gallery') {
      const items = GALLERY.filter((g) => (!q.language || g.languages.includes(q.language)) && (!q.q || g.name.toLowerCase().includes(q.q.toLowerCase())))
      return response(items)
    }
    if (method === 'GET' && /^\/voices\/gallery\/[\w-]+\/sample$/.test(path)) {
      if (waits > 0) {
        waits -= 1
        return new Response(JSON.stringify({ job: job('s1', { type: 'voice_sample', status: 'running' }), status: 'preparing' }), { status: 202 })
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }
    if (method === 'POST' && /^\/voices\/gallery\/[\w-]+\/add$/.test(path)) {
      const id = path.split('/')[3]
      return voice('v9', { name: GALLERY.find((g) => g.id === id)?.name, kind: 'design', starred: !!b?.starred })
    }
    if (method === 'PATCH' && path.startsWith('/voices/')) return voice(path.split('/')[2], { name: 'Charlotte, UK newsreader', starred: false })
    if (method === 'POST' && path === '/audio/speak') {
      const item = audioItem('s1', { title: 'Take', media_url: null, params: { kind: 'speech', voice_id: b.voice_id, text: b.text } })
      return { items: [item], jobs: [job('j1', { generation_id: item.generation_id })], engine_resolved: 'omnivoice', seed: 1 }
    }
    if (path === '/media') return { items: [] }
    if (path === '/jobs') return []
    if (path.startsWith('/favourites')) return { refs: [] }
  })
}

const routes = [
  { path: '/audio/gallery', element: <GalleryPage /> },
  { path: '/audio/speak', element: <SpeakPage /> },
]

const card = (name: string) => screen.getByRole('heading', { name }).closest<HTMLElement>('[data-card]')!
const location = () => screen.getByTestId('location').textContent

beforeEach(() => {
  stubMedia()
  resetPlayer()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('lib/gallery', () => {
  it('dresses a gallery voice as a library voice', () => {
    const v = galleryAsVoice(GALLERY[0])
    expect(v).toMatchObject({ id: 'gallery:ur-dadi', kind: 'design', language: 'ur', design: { description: 'female, middle-aged', seed: 1, engine: 'omnivoice' } })
    expect(galleryAsVoice(GALLERY[2]).preset).toEqual({ engine: 'kokoro', id: 'af_heart' })
    expect(isGalleryId('gallery:x')).toBe(true)
    expect(isGalleryId('v1')).toBe(false)
    expect(initialsOf('Aamir, Lahore narrator')).toBe('AL')
    expect(initialsOf('Alpha (Hindi)')).toBe('A')
    expect(matchesGallery(GALLERY[1], 'lahori narrator')).toBe(true)
    expect(matchesGallery(GALLERY[1], 'urdu', (c) => (c === 'ur' ? 'Urdu' : c))).toBe(true)
    expect(matchesGallery(GALLERY[1], 'whisper')).toBe(false)
  })
})

describe('Gallery page', () => {
  it('shows cards and filter chips with counts; chips and search filter on the server', async () => {
    const calls = api()
    renderAt('/audio/gallery', routes)
    const user = userEvent.setup()
    expect(await screen.findByRole('heading', { name: 'Aamir, Lahore narrator' })).toBeInTheDocument()
    expect(screen.getByText('4 voices')).toBeInTheDocument()
    expect(within(card('Heart')).getByText('Kokoro')).toBeInTheDocument()
    expect(within(card('Aamir, Lahore narrator')).getByText(/Lahori Urdu · Urdu/)).toBeInTheDocument()

    const languages = screen.getByRole('group', { name: 'Language' })
    expect(within(languages).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(languages).getByRole('button', { name: 'Urdu (2)' }))
    await waitFor(() => expect(screen.getByText('2 voices')).toBeInTheDocument())
    expect(calls.some((c) => c.path === '/voices/gallery' && c.query.language === 'ur')).toBe(true)
    expect(within(languages).getByRole('button', { name: 'Urdu (2)' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('heading', { name: 'Heart' })).not.toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search the gallery' }), 'dadi')
    await waitFor(() => expect(screen.getByText('1 voice')).toBeInTheDocument())
    expect(calls.some((c) => c.path === '/voices/gallery' && c.query.q === 'dadi' && c.query.language === 'ur')).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(screen.getByText('4 voices')).toBeInTheDocument())
  })

  it('plays a ready sample straight away, and polls one that is still being prepared', async () => {
    // the sample check polls every 2 s; skip the wait rather than sit through it
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api({ preparing: 1 })
    renderAt('/audio/gallery', routes)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Aamir, Lahore narrator' })

    await user.click(screen.getByRole('button', { name: 'Play the sample of Aamir, Lahore narrator' }))
    expect(usePlayer.getState()).toMatchObject({ id: 'gallery:ur-lahore-narrator', src: '/api/voices/gallery/ur-lahore-narrator/sample', title: 'Aamir, Lahore narrator' })

    await user.click(screen.getByRole('button', { name: 'Play the sample of Dadi Amma, grandmother' }))
    expect(await within(card('Dadi Amma, grandmother')).findByText('Preparing sample…')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(2000))
    await waitFor(() => expect(usePlayer.getState().id).toBe('gallery:ur-dadi'))
    expect(usePlayer.getState().src).toBe('/api/voices/gallery/ur-dadi/sample')
    expect(within(card('Dadi Amma, grandmother')).queryByText('Preparing sample…')).not.toBeInTheDocument()
  })

  it('adds to my voices, stars, unstars and uses a voice in Speak', async () => {
    const calls = api()
    renderAt('/audio/gallery', routes)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Heart' })

    expect(within(card('Charlotte, UK newsreader')).getByText('In my voices')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add Heart to my voices' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/voices/gallery/af_heart/add')).toHaveLength(1))

    await user.click(screen.getByRole('button', { name: 'Star Dadi Amma, grandmother' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/voices/gallery/ur-dadi/add')?.body).toEqual({ starred: true }))

    const charlotte = screen.getByRole('button', { name: 'Star Charlotte, UK newsreader' })
    expect(charlotte).toHaveAttribute('aria-pressed', 'true')
    await user.click(charlotte)
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.path === '/voices/v7')?.body).toEqual({ starred: false }))

    await user.click(screen.getByRole('button', { name: 'Use Heart in Speak' }))
    expect(location()).toBe('/audio/speak?voice=gallery%3Aaf_heart')
  })

  it('moves between cards with the arrow keys; Space plays and Enter uses', async () => {
    api()
    renderAt('/audio/gallery', routes)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Heart' })

    const first = card('Dadi Amma, grandmother')
    expect(first).toHaveAttribute('tabindex', '0')
    expect(card('Heart')).toHaveAttribute('tabindex', '-1')
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(card('Aamir, Lahore narrator')).toHaveFocus()
    await user.keyboard('{End}')
    expect(card('Charlotte, UK newsreader')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(card('Heart')).toHaveFocus()
    await user.keyboard('{Home}{ArrowRight}')
    expect(card('Aamir, Lahore narrator')).toHaveFocus()
    expect(card('Aamir, Lahore narrator')).toHaveAttribute('tabindex', '0')

    await user.keyboard(' ')
    expect(usePlayer.getState().id).toBe('gallery:ur-lahore-narrator')
    await user.keyboard('{Enter}')
    expect(location()).toBe('/audio/speak?voice=gallery%3Aur-lahore-narrator')
  })
})

describe('Voice picker: Gallery section', () => {
  it('lists gallery voices for the line language, searches them, and speaks with the one picked', async () => {
    const calls = api()
    renderAt('/audio/speak?voice=v1', routes)
    const user = userEvent.setup()
    // Ayesha is Urdu, so the Gallery section starts on Urdu
    await screen.findByRole('button', { name: 'Language: Urdu' })
    const pop = await openChip(user, 'Voice')
    const section = within(pop).getByRole('region', { name: 'Gallery' })
    expect(within(section).getByRole('combobox', { name: 'Gallery language' })).toHaveValue('ur')
    const names = () => within(within(section).getByRole('list', { name: 'Voice gallery choices' })).queryAllByRole('button').map((b) => b.textContent)
    expect(names()).toHaveLength(2)
    expect(names()[0]).toMatch(/^DADadi Amma/)

    await user.selectOptions(within(section).getByRole('combobox', { name: 'Gallery language' }), '')
    expect(names()).toHaveLength(4)
    await user.type(within(pop).getByRole('searchbox', { name: 'Search voices' }), 'heart')
    await waitFor(() => expect(names()).toHaveLength(1))
    // the library's own Heart (a preset) still shows under My voices
    expect(within(pop).getByRole('list', { name: 'Voice choices' })).toHaveTextContent('Heart')

    await user.click(within(section).getByRole('button', { name: /Heart/ }))
    expect(await screen.findByRole('button', { name: 'Voice: Heart' })).toBeInTheDocument()
    // a Kokoro voice speaks English: the language follows the voice
    expect(screen.getByRole('button', { name: 'Language: English' })).toBeInTheDocument()

    await user.click(screen.getByRole('textbox', { name: 'Script' }))
    await user.paste('Good evening.')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/audio/speak')?.body).toMatchObject({ voice_id: 'gallery:af_heart', language: 'en' }))
  })

  it('arriving from the gallery with ?voice=gallery:<id> picks it and its language', async () => {
    api()
    renderAt('/audio/speak?voice=gallery:ur-dadi', routes)
    expect(await screen.findByRole('button', { name: 'Voice: Dadi Amma, grandmother' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Language: Urdu' })).toBeInTheDocument()
  })
})
