import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qk } from '@/hooks/keys'
import { activeRail, pageTitle } from '@/lib/nav'
import { job, mockApi, renderAt, systemOk } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'
import { Rail } from './Rail'
import { CLOSE_DELAY, OPEN_DELAY } from './useMegaMenu'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderRail(path = '/', jobs = [job('a')], catalog = false) {
  mockApi((_m, p) => {
    if (p === '/system/status') return systemOk
    if (p === '/auth/me') return { id: 'u', email: 'ada@studio.test', display_name: 'Ada', workspace_id: 'w1', role: 'owner' }
  })
  return renderAt(
    path,
    [{ path: '/elsewhere', element: <p>away</p> }],
    (qc) => {
      qc.setQueryData(qk.jobs, jobs)
      if (catalog) seedCatalog(qc)
    },
    <Rail />,
  )
}

const rail = () => screen.getByRole('navigation', { name: 'Main' })
const trigger = (name: string) => within(rail()).getByRole('button', { name })

describe('rail', () => {
  it('maps every route to its rail item, upscale pages to Upscale and studio projects to Video', () => {
    expect(activeRail('/')).toBe('home')
    expect(activeRail('/image/edit')).toBe('image')
    expect(activeRail('/image/upscale')).toBe('upscale')
    expect(activeRail('/video/upscale')).toBe('upscale')
    expect(activeRail('/projects/p1/render')).toBe('video')
    expect(activeRail('/quick/q1')).toBe('video')
    expect(activeRail('/settings')).toBe('settings')
    expect(pageTitle('/video/projects/')).toBe('Studio projects')
    expect(pageTitle('/projects')).toBe('Studio projects')
  })

  it('marks the current section and shows the running-job count on Queue', () => {
    renderRail('/image/library', [job('a', { status: 'running' }), job('b', { status: 'running' }), job('c', { status: 'queued' })])
    expect(trigger('Image')).toHaveAttribute('aria-current', 'true')
    expect(trigger('Video')).not.toHaveAttribute('aria-current')
    const queue = within(rail()).getByRole('link', { name: 'Queue, 2 running' })
    expect(queue).toHaveAttribute('href', '/queue')
    expect(queue).toHaveTextContent('2')
    expect(within(rail()).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
  })

  it('home is a plain link with aria-current on /', () => {
    renderRail('/', [])
    expect(within(rail()).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    expect(within(rail()).getByRole('link', { name: 'Queue, 0 running' })).toBeInTheDocument()
  })

  it('opens on hover after the intent delay and closes after the grace period', () => {
    vi.useFakeTimers()
    renderRail()
    const image = trigger('Image')

    fireEvent.pointerOver(image, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(OPEN_DELAY - 20))
    expect(image).toHaveAttribute('aria-expanded', 'false')
    act(() => vi.advanceTimersByTime(40))
    expect(image).toHaveAttribute('aria-expanded', 'true')
    const panel = screen.getByRole('group', { name: 'Image Tools' })
    expect(within(panel).getByRole('link', { name: /Create Image/ })).toHaveAttribute('href', '/image/generate')

    // leaving and coming back into the panel inside the grace period keeps it open
    fireEvent.pointerOut(image, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(CLOSE_DELAY - 50))
    fireEvent.pointerOver(panel, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(CLOSE_DELAY * 2))
    expect(image).toHaveAttribute('aria-expanded', 'true')

    fireEvent.pointerOut(panel, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(CLOSE_DELAY + 10))
    expect(image).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'Image Tools' })).not.toBeInTheDocument()
  })

  it('a quick pass over an item does not open it', () => {
    vi.useFakeTimers()
    renderRail()
    fireEvent.pointerOver(trigger('Video'), { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(60))
    fireEvent.pointerOut(trigger('Video'), { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(1000))
    expect(trigger('Video')).toHaveAttribute('aria-expanded', 'false')
  })

  it('is fully usable from the keyboard: Enter opens, arrows and Tab move, Esc closes and returns focus', async () => {
    renderRail()
    const user = userEvent.setup()
    trigger('Image').focus()
    await user.keyboard('{Enter}')
    const panel = screen.getByRole('group', { name: 'Image Tools' })
    expect(within(panel).getByRole('link', { name: /Create Image/ })).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(within(panel).getByRole('link', { name: /Edit Image/ })).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(within(panel).getByRole('link', { name: /^Library/ })).toHaveFocus()

    // Tab hops to the Models column and back, so focus stays in the panel
    await user.keyboard('{Tab}')
    expect(within(panel).getByRole('link', { name: /Z-Image Turbo, FAST/ })).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(within(panel).getByRole('link', { name: /Create Image/ })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Image Tools' })).not.toBeInTheDocument()
    expect(trigger('Image')).toHaveFocus()
    expect(trigger('Image')).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on an outside click, and tap toggles on touch', async () => {
    renderRail()
    const video = trigger('Video')
    fireEvent.pointerDown(video, { pointerType: 'touch' })
    fireEvent.click(video, { detail: 1 })
    expect(video).toHaveAttribute('aria-expanded', 'true')
    fireEvent.pointerDown(video, { pointerType: 'touch' })
    fireEvent.click(video, { detail: 1 })
    expect(video).toHaveAttribute('aria-expanded', 'false')

    fireEvent.pointerDown(video, { pointerType: 'touch' })
    fireEvent.click(video, { detail: 1 })
    expect(screen.getByRole('group', { name: 'Video Tools' })).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('group', { name: 'Video Tools' })).not.toBeInTheDocument()
  })

  it('a model opens its tool with that model preselected, and the menu closes', async () => {
    renderRail('/elsewhere')
    const user = userEvent.setup()
    await user.click(trigger('Upscale'))
    const panel = screen.getByRole('group', { name: 'Upscale' })
    await user.click(within(panel).getByRole('link', { name: /FlashVSR 1\.1 · video/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/video/upscale?engine=fast')
    expect(screen.queryByRole('group', { name: 'Upscale' })).not.toBeInTheDocument()
    expect(trigger('Upscale')).toHaveAttribute('aria-current', 'true')
  })

  it('falls back to the integrated models on an older server, and keeps LoRAs as a later, disabled feature', async () => {
    renderRail()
    const user = userEvent.setup()
    await user.click(trigger('Video'))
    const video = screen.getByRole('group', { name: 'Video Tools' })
    expect(within(video).queryByText(/Wan 2\.2/)).not.toBeInTheDocument()
    expect(within(video).getByRole('link', { name: /LTX-2\.3/ })).toHaveAttribute('href', '/video/create?model=ltx23_distilled')

    await user.click(trigger('Assets'))
    const assets = screen.getByRole('group', { name: 'Assets' })
    expect(within(assets).getByText('LoRAs').closest('[aria-disabled]')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('group', { name: 'Video Tools' })).not.toBeInTheDocument()
  })

  it('fills the Models column from the catalog, skips unavailable models, and preselects on click', async () => {
    renderRail('/elsewhere', [], true)
    const user = userEvent.setup()
    await user.click(trigger('Image'))
    const image = screen.getByRole('group', { name: 'Image Tools' })
    expect(within(image).getByRole('link', { name: /^Qwen-Image 2512, TEXT: Text & posters/ })).toHaveAttribute('href', '/image/generate?model=qwen_image_2512')
    expect(within(image).queryByText('FLUX.2 klein 4B')).not.toBeInTheDocument()

    await user.click(trigger('Video'))
    const video = screen.getByRole('group', { name: 'Video Tools' })
    expect(within(video).getByRole('link', { name: /Create Video/ })).toHaveAttribute('href', '/video/create')
    expect(within(video).getByRole('link', { name: /^LTX-2\.3 High quality, HQ/ })).toBeInTheDocument()
    await user.click(within(video).getByRole('link', { name: /^Wan 2\.2 14B/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/video/create?model=wan22_t2v')
  })

  it('puts connection state on the Settings item', async () => {
    renderRail()
    expect(await within(rail()).findByRole('link', { name: 'Settings. ComfyUI connected, Ollama offline' })).toHaveAttribute('href', '/settings')
    expect(within(rail()).getByRole('button', { name: /Account menu/ })).toBeInTheDocument()
  })
})
