import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAG_MIME } from '@/lib/selection'
import type { Folder } from '@/lib/types'
import { job, media, mockApi, renderAt, T } from '@/test/media-fixtures'
import { LibraryPage } from './LibraryPage'

afterEach(() => vi.unstubAllGlobals())

const folder = (id: string, name: string, extra: Partial<Folder> = {}): Folder => ({
  id,
  name,
  parent_id: null,
  kind: 'any',
  sort: 0,
  item_count: 0,
  created_at: T,
  updated_at: T,
  ...extra,
})

const items = [
  media('a', { title: 'Alpha' }),
  media('b', { title: 'Bravo' }),
  media('c', { title: 'Charlie', origin: 'project' }),
  media('d', { title: 'Delta' }),
]
const folders = [folder('f1', 'Campaign', { item_count: 2 }), folder('f2', 'Drafts', { parent_id: 'f1' })]

function api(over: (method: string, path: string, body: unknown, q: Record<string, string>) => unknown = () => undefined) {
  return mockApi((method, path, q, body) => {
    const hit = over(method, path, body, q)
    if (hit !== undefined) return hit
    if (path === '/media') return { items: q.folder_id === 'f1' ? items.slice(0, 1) : items }
    if (path === '/folders' && method === 'GET') return folders
    if (path === '/saved-filters' && method === 'GET') return []
    if (path === '/media/batch') {
      const b = body as { action: string; refs: string[] }
      const project = b.refs.filter((r) => r.startsWith('gen:'))
      return {
        action: b.action,
        done: b.action === 'delete' ? b.refs.filter((r) => !r.startsWith('gen:')) : b.refs,
        skipped: b.action === 'delete' ? project.map((ref) => ({ ref, reason: 'Project results are changed inside their project' })) : [],
        jobs: b.action === 'download' ? [job('z1', { type: 'media_zip' })] : [],
      }
    }
    if (path === '/media/move') return { action: 'move', done: (body as { refs: string[] }).refs, skipped: [], jobs: [] }
  })
}

const open = (path = '/image/library') => renderAt(path, [{ path: '/image/library', element: <LibraryPage kind="image" /> }])
const box = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` })

describe('multi-select and the batch bar', () => {
  it('checkbox, Shift range, Ctrl-click on the picture, Ctrl+A and Esc', async () => {
    api()
    open()
    const user = userEvent.setup()
    await screen.findByRole('img', { name: 'Alpha' })
    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).not.toBeInTheDocument()

    await user.click(box('Alpha'))
    expect(box('Alpha')).toHaveAttribute('aria-checked', 'true')
    const bar = screen.getByRole('toolbar', { name: 'Selection actions' })
    expect(bar).toHaveTextContent('1 selected')

    await user.keyboard('{Shift>}')
    await user.click(box('Charlie'))
    await user.keyboard('{/Shift}')
    expect(within(bar).getByText('3 selected')).toBeInTheDocument()
    expect(box('Bravo')).toHaveAttribute('aria-checked', 'true')

    // while selecting, a click on a picture picks it instead of opening the lightbox
    await user.click(screen.getByRole('button', { name: 'View Delta' }))
    expect(box('Delta')).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View Bravo' }))
    expect(box('Bravo')).toHaveAttribute('aria-checked', 'false')

    fireEvent.keyDown(screen.getByRole('main'), { key: 'Escape' })
    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('main'), { key: 'a', ctrlKey: true })
    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).toHaveTextContent('4 selected')
  })

  it('a drag-box selects what it touches', async () => {
    api()
    open()
    await screen.findByRole('img', { name: 'Alpha' })
    // lay the tiles out in a row, 100 px apart
    document.querySelectorAll<HTMLElement>('[data-select-id]').forEach((el, i) => {
      el.getBoundingClientRect = () => ({ left: i * 100, top: 0, right: i * 100 + 90, bottom: 90, width: 90, height: 90, x: i * 100, y: 0, toJSON: () => ({}) })
    })
    const grid = screen.getByRole('region', { name: 'Images' })
    fireEvent.pointerDown(grid, { clientX: 95, clientY: 50, button: 0, pointerType: 'mouse' })
    fireEvent.pointerMove(grid, { clientX: 250, clientY: 60, pointerType: 'mouse' })
    expect(screen.getByTestId('marquee')).toBeInTheDocument()
    fireEvent.pointerUp(grid, { clientX: 250, clientY: 60, pointerType: 'mouse' })
    expect(box('Bravo')).toHaveAttribute('aria-checked', 'true')
    expect(box('Charlie')).toHaveAttribute('aria-checked', 'true')
    expect(box('Alpha')).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByTestId('marquee')).not.toBeInTheDocument()
  })

  it('Delete confirms, sends refs (project rows as gen:) and reports what was skipped', async () => {
    const calls = api()
    open()
    const user = userEvent.setup()
    await screen.findByRole('img', { name: 'Alpha' })
    await user.click(box('Alpha'))
    await user.click(box('Charlie'))
    await user.click(within(screen.getByRole('toolbar', { name: 'Selection actions' })).getByRole('button', { name: 'Delete' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm).toHaveTextContent('Delete 1 item?')
    expect(confirm).toHaveTextContent('1 project result will be left alone')
    await user.click(within(confirm).getByRole('button', { name: 'Delete 1 item' }))
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: '/media/batch', body: { action: 'delete', refs: ['a', 'gen:c'], options: {} } })))
    expect(await screen.findByText(/Deleted 1 item\. 1 skipped: Project results are changed inside their project/)).toBeInTheDocument()
  })

  it('Download zip queues a job and offers the file when it is done', async () => {
    const calls = api()
    const { qc } = open()
    const user = userEvent.setup()
    await screen.findByRole('img', { name: 'Alpha' })
    await user.click(box('Alpha'))
    await user.click(box('Bravo'))
    await user.click(screen.getByRole('button', { name: 'Download zip' }))
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: '/media/batch', body: { action: 'download', refs: ['a', 'b'], options: {} } })))
    expect(await screen.findByText(/Making the zip/)).toBeInTheDocument()
    act(() => qc.setQueryData(['jobs'], [job('z1', { type: 'media_zip', status: 'done', progress: 1 })]))
    expect(await screen.findByRole('link', { name: 'Download the zip' })).toHaveAttribute('href', '/api/exports/z1/download')
  })

  it('Upscale and Tag go through their dialogs', async () => {
    const calls = api()
    open()
    const user = userEvent.setup()
    await screen.findByRole('img', { name: 'Alpha' })
    await user.click(box('Alpha'))
    await user.click(screen.getByRole('button', { name: 'Upscale' }))
    const dlg = screen.getByRole('dialog', { name: 'Upscale 1 item' })
    await user.click(within(dlg).getByRole('button', { name: 'Quick' }))
    await user.click(within(dlg).getByRole('button', { name: '4×' }))
    await user.click(within(dlg).getByRole('button', { name: 'Upscale 1 item' }))
    await waitFor(() =>
      expect(calls).toContainEqual(expect.objectContaining({ path: '/media/batch', body: { action: 'upscale', refs: ['a'], options: { image: { engine: 'quick', target: '4x' } } } })),
    )

    await user.click(screen.getByRole('button', { name: 'Tag' }))
    await user.type(screen.getByRole('textbox', { name: 'Add tags' }), 'Spring, b-roll')
    await user.click(screen.getByRole('button', { name: 'Save tags' }))
    await waitFor(() =>
      expect(calls).toContainEqual(expect.objectContaining({ path: '/media/batch', body: { action: 'tag', refs: ['a'], options: { add: ['spring', 'b-roll'], remove: [] } } })),
    )
  })
})

describe('folders', () => {
  it('shows the tree and breadcrumbs, and opens a folder through the URL', async () => {
    const calls = api()
    open('/image/library?folder=f1')
    const tree = await screen.findByRole('navigation', { name: 'Folders' })
    expect(await within(tree).findByRole('button', { name: /^Campaign/ })).toHaveAttribute('aria-current', 'true')
    expect(within(screen.getByRole('navigation', { name: 'Folder path' })).getByText('Campaign')).toHaveAttribute('aria-current', 'location')
    await waitFor(() => expect(calls.filter((c) => c.path === '/media').at(-1)?.query).toMatchObject({ folder_id: 'f1' }))
    // the child is visible because we're inside its parent
    await userEvent.setup().click(within(tree).getByRole('button', { name: /^Drafts/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/image/library?folder=f2')
  })

  it('creates a folder inline', async () => {
    const calls = api((m, path) => (m === 'POST' && path === '/folders' ? folder('f9', 'Moodboard') : undefined))
    open()
    const user = userEvent.setup()
    const tree = await screen.findByRole('navigation', { name: 'Folders' })
    await user.click(within(tree).getByRole('button', { name: 'New folder' }))
    await user.type(within(tree).getByRole('textbox', { name: 'New folder name' }), 'Moodboard{Enter}')
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/folders', body: { name: 'Moodboard', parent_id: null, kind: 'image' } })))
  })

  it('dropping tiles on a folder moves the whole selection', async () => {
    const calls = api()
    open()
    const user = userEvent.setup()
    await screen.findByRole('img', { name: 'Alpha' })
    await user.click(box('Alpha'))
    await user.click(box('Charlie'))
    const store = new Map<string, string>()
    const dataTransfer = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? '',
      get types() {
        return [...store.keys()]
      },
      effectAllowed: '',
      dropEffect: '',
    }
    fireEvent.dragStart(document.querySelector('[data-select-id="a"]')!, { dataTransfer })
    expect(JSON.parse(store.get(DRAG_MIME)!)).toEqual(['a', 'gen:c'])
    const target = within(screen.getByRole('navigation', { name: 'Folders' })).getByRole('button', { name: /^Campaign/ })
    fireEvent.dragOver(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: '/media/move', body: { refs: ['a', 'gen:c'], folder_id: 'f1' } })))
    expect(await screen.findByText('Moved 2 items.')).toBeInTheDocument()
  })

  it('M opens the keyboard move dialog', async () => {
    const calls = api()
    open()
    const user = userEvent.setup()
    await screen.findByRole('img', { name: 'Alpha' })
    await user.click(box('Bravo'))
    fireEvent.keyDown(screen.getByRole('main'), { key: 'm' })
    const dlg = await screen.findByRole('dialog', { name: 'Move 1 item' })
    await user.click(within(dlg).getByRole('radio', { name: 'Drafts' }))
    await user.click(within(dlg).getByRole('button', { name: 'Move here' }))
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: '/media/move', body: { refs: ['b'], folder_id: 'f2' } })))
  })
})

describe('favourites and saved filters', () => {
  it('filters to favourites and saves the filter', async () => {
    const calls = api((m, path, body) => (m === 'POST' && path === '/saved-filters' ? { id: 's1', ...(body as object), created_at: T, updated_at: T } : undefined))
    open()
    const user = userEvent.setup()
    await screen.findByRole('img', { name: 'Alpha' })
    await user.click(screen.getByRole('button', { name: 'Favourites' }))
    await waitFor(() => expect(calls.filter((c) => c.path === '/media').at(-1)?.query).toMatchObject({ favourite: '1', kind: 'image' }))
    await user.click(screen.getByRole('button', { name: 'Save this filter' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Hearts')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/saved-filters', body: { name: 'Hearts', query: { kind: 'image', favourite: true } } })),
    )
  })

  it('applies a saved filter', async () => {
    const calls = api((m, path) =>
      m === 'GET' && path === '/saved-filters' ? [{ id: 's1', name: 'Sea uploads', query: { kind: 'image', origin: 'upload', tag: 'sea' }, created_at: T, updated_at: T }] : undefined,
    )
    open()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Sea uploads' }))
    await waitFor(() => expect(calls.filter((c) => c.path === '/media').at(-1)?.query).toMatchObject({ origin: 'upload', tag: 'sea' }))
  })
})
