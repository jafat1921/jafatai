import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { libraryFilter } from '@/hooks/useMedia'
import { checkFile, uploadErrorText } from '@/lib/upload'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { LibraryPage } from './LibraryPage'

afterEach(() => vi.unstubAllGlobals())

const file = (name: string, type: string, bytes: number) => {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: bytes })
  return f
}

describe('library filters', () => {
  it('maps the chips to the contract query', () => {
    expect(libraryFilter('image', 'all', '', null)).toEqual({ kind: 'image', include: 'project' })
    expect(libraryFilter('video', 'upload', ' reef ', 'b-roll')).toEqual({ kind: 'video', origin: 'upload', q: 'reef', tag: 'b-roll' })
  })

  it('loads, filters by origin and tag, searches, and pages with the cursor', async () => {
    const calls = mockApi((_m, path, q) => {
      if (path !== '/media') return
      if (q.cursor === 'c2') return { items: [media('p2', { title: 'Second page' })] }
      if (q.origin === 'upload') return { items: [media('u1', { origin: 'upload', title: 'My upload' })] }
      return { items: [media('a', { title: 'Reef at dawn', tags: ['reef'] }), media('b', { origin: 'project', title: 'Approved frame' })], next_cursor: 'c2' }
    })
    renderAt('/image/library', [{ path: '/image/library', element: <LibraryPage kind="image" /> }])
    const user = userEvent.setup()

    expect(await screen.findByRole('img', { name: 'Reef at dawn' })).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/media')).toMatchObject({ query: { kind: 'image', include: 'project', limit: '40' } })
    // project rows can't be deleted (the server answers 409)
    expect(within(screen.getByRole('group', { name: 'Actions for Approved frame' })).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('img', { name: 'Second page' })).toBeInTheDocument()
    expect(calls.at(-1)).toMatchObject({ query: { cursor: 'c2', kind: 'image' } })

    await user.click(within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'reef' }))
    await waitFor(() => expect(calls.at(-1)?.query).toMatchObject({ tag: 'reef', include: 'project' }))

    await user.click(within(screen.getByRole('group', { name: 'Where from' })).getByRole('button', { name: 'Uploads' }))
    expect(await screen.findByRole('img', { name: 'My upload' })).toBeInTheDocument()
    expect(calls.at(-1)?.query).toMatchObject({ kind: 'image', origin: 'upload' })
    expect(calls.at(-1)?.query.include).toBeUndefined()

    await user.type(screen.getByRole('searchbox', { name: 'Search images' }), 'fox')
    await waitFor(() => expect(calls.at(-1)?.query).toMatchObject({ q: 'fox', origin: 'upload' }))
  })

  it('deletes after confirming', async () => {
    const calls = mockApi((method, path) => {
      if (path === '/media') return { items: [media('a', { title: 'Old take' })] }
      if (method === 'DELETE') return new Response(null, { status: 204 })
    })
    renderAt('/image/library', [{ path: '/image/library', element: <LibraryPage kind="image" /> }])
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'More for Old take' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Old take' })).not.toBeInTheDocument())
    expect(calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/media/a' }))
  })
})

describe('uploads', () => {
  it('rejects the wrong type or size before sending, in plain words', () => {
    expect(checkFile(file('notes.pdf', 'application/pdf', 10), ['image'])).toMatch(/isn't a file type we can use. Try PNG, JPG or WebP up to 40 MB/)
    expect(checkFile(file('huge.png', 'image/png', 50 * 1024 * 1024), ['image'])).toBe('“huge.png” is 50 MB, bigger than the 40 MB limit for images.')
    expect(checkFile(file('clip.mov', '', 10), ['video'])).toBeNull()
    expect(checkFile(file('clip.mov', '', 3 * 1024 ** 3), ['video'])).toMatch(/3\.0 GB, bigger than the 2\.0 GB limit/)
  })

  it('explains 413 and 415 answers from the server', () => {
    expect(uploadErrorText(413, 'Request Entity Too Large', 'a.png')).toMatch(/too big for the server/)
    expect(uploadErrorText(415, 'bad', 'a.png')).toMatch(/isn't a supported image or video, even if its name says so/)
    expect(uploadErrorText(400, 'Corrupt PNG', 'a.png')).toBe('Corrupt PNG')
  })

  it('shows progress and the server’s refusal on the file’s row', async () => {
    mockApi((_m, path) => (path === '/media' ? { items: [] } : undefined))
    const sent: FormData[] = []
    class FakeXhr {
      status = 0
      responseText = ''
      upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
      onload?: () => void
      onerror?: () => void
      onabort?: () => void
      withCredentials = false
      open() {}
      setRequestHeader() {}
      abort() {}
      send(body: FormData) {
        sent.push(body)
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
        setTimeout(() => {
          this.status = 415
          this.responseText = JSON.stringify({ detail: 'unsupported media type' })
          this.onload?.()
        }, 10)
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    renderAt('/image/library', [{ path: '/image/library', element: <LibraryPage kind="image" /> }])

    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [file('fake.png', 'image/png', 100)] } })
    const rows = screen.getByRole('list', { name: 'Uploads' })
    expect(within(rows).getByRole('progressbar', { name: 'Uploading fake.png' })).toBeInTheDocument()
    expect(await within(rows).findByRole('alert')).toHaveTextContent(/“fake.png” isn't a supported image or video/)
    expect(sent[0].get('file')).toBeInstanceOf(File)

    // a local refusal never reaches the network
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files: [file('song.mp3', 'audio/mpeg', 100)] } })
    expect(await within(rows).findByText(/“song.mp3” isn't a file type we can use/)).toBeInTheDocument()
    expect(sent).toHaveLength(1)
  })
})

describe('upscaled items (P5)', () => {
  it('badges the tile and ?open shows original and upscaled versions, each downloadable', async () => {
    const item = media('a', { title: 'The Luminous Tree', generation_id: 'g-up', upscale: { target: '4k', label: '4K' }, original_generation_id: 'g-orig', versions_count: 2 })
    const v = (id: string, version: number, params: Record<string, unknown>) => ({
      id, target_type: 'media', target_id: 'a', kind: 'image', version, status: 'ready', prompt: 'a tree', params, seed: 1,
      media_url: `/api/media/${id}.png`, thumb_url: `/api/media/thumb/${id}?w=512`, created_at: item.created_at,
    })
    mockApi((_m, path) => {
      if (path === '/media') return { items: [item] }
      if (path === '/media/a') return { ...item, versions: [v('g-up', 2, { upscale: { target: '4k' } }), v('g-orig', 1, {})] }
    })
    renderAt('/image/library?open=a', [{ path: '/image/library', element: <LibraryPage kind="image" /> }])
    expect(await screen.findByText('Upscaled · 4K', { selector: 'span.pointer-events-none' })).toBeInTheDocument()
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByRole('link', { name: 'Download version 1 (original)' })).toHaveAttribute('href', '/api/generations/g-orig/download')
    expect(within(sheet).getByRole('link', { name: 'Download version 2 (upscaled · 4k)' })).toHaveAttribute('href', '/api/generations/g-up/download')
  })
})
