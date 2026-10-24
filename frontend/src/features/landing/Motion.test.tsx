import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import { LandingPage } from './LandingPage'
import { StudioPage } from './StudioPage'
import { PlansPage } from './PlansPage'
import { AboutPage } from './AboutPage'

afterEach(() => vi.unstubAllGlobals())

const IDEA = 'A little cloud who wants to help…'

function server() {
  mockApi((_method, path) => {
    if (path === '/auth/config') return { signup: 'open', google: false, verify: true }
    if (path === '/auth/me') return new Response(JSON.stringify({ detail: 'Not signed in' }), { status: 401 })
    if (path === '/site/plans') return []
  })
}

// jsdom has neither; each test says whether stillness was asked for
function browser({ reduce }: { reduce: boolean }) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') ? reduce : q.includes('fine'), media: q, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        // everything is on screen at once in these tests
        queueMicrotask(() => this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver))
      }
      unobserve() {}
      disconnect() {}
    },
  )
}

const home = () => renderAt('/', [{ path: '/', element: <LandingPage /> }])

describe('motion on the public site', () => {
  it('stays still and fully shown when reduced motion is asked for', async () => {
    browser({ reduce: true })
    server()
    const { container } = home()
    await screen.findByRole('heading', { level: 1 })
    expect(container.querySelector('.jafat')).not.toHaveClass('motion')
    expect(container.querySelectorAll('.is-in, .is-live')).toHaveLength(0)
    expect(container.querySelector('.prompt-text')).toHaveTextContent(IDEA)
    expect(container.querySelector('.caret')).toBeNull()
    expect(container.querySelector('.polaroids')).toHaveAttribute('data-drift', 'off')
  })

  it('shows everything without the observer too (no JS motion, nothing hidden)', async () => {
    server()
    const { container } = home()
    await screen.findByRole('heading', { level: 1 })
    expect(container.querySelector('.jafat')).not.toHaveClass('motion')
    expect(container.querySelector('.prompt-text')).toHaveTextContent(IDEA)
  })

  it('reveals sections and types the idea out to the end, under a steady label', async () => {
    browser({ reduce: false })
    server()
    const { container } = home()
    await screen.findByRole('heading', { level: 1 })
    expect(container.querySelector('.jafat')).toHaveClass('motion')
    await waitFor(() => expect(container.querySelector('.formats')).toHaveClass('is-in', 'is-live'))
    const prompt = screen.getByRole('link', { name: 'Try your own idea' })
    await waitFor(() => expect(prompt.querySelector('.prompt-text')).toHaveTextContent(IDEA), { timeout: 4000 })
    await waitFor(() => expect(prompt.querySelector('.caret')).toBeNull())
    expect(screen.getByRole('link', { name: 'Try your own idea' })).toBe(prompt)
  })

  it('stops the gallery drifting while it has focus or the pointer', async () => {
    browser({ reduce: false })
    server()
    const { container } = home()
    await screen.findByRole('heading', { level: 1 })
    const strip = container.querySelector('.polaroids') as HTMLElement
    expect(strip).toHaveAttribute('data-drift', 'running')
    fireEvent.focusIn(strip)
    expect(strip).toHaveAttribute('data-drift', 'paused')
    fireEvent.focusOut(strip, { relatedTarget: document.body })
    expect(strip).toHaveAttribute('data-drift', 'running')
    fireEvent.pointerEnter(strip)
    expect(strip).toHaveAttribute('data-drift', 'paused')
  })

  it.each([
    ['/studio', <StudioPage />],
    ['/plans', <PlansPage />],
    ['/about', <AboutPage />],
  ] as const)('%s unfurls its sections as they come into view', async (path, element) => {
    browser({ reduce: false })
    server()
    const { container } = renderAt(path, [{ path, element }])
    await screen.findByRole('heading', { level: 1 })
    const blocks = [...container.querySelectorAll('[data-reveal]')]
    expect(blocks.length).toBeGreaterThan(0)
    await waitFor(() => blocks.forEach((b) => expect(b).toHaveClass('is-in')))
  })

  it('never mentions assistants or integrations on the public pages', async () => {
    for (const [path, element] of [
      ['/', <LandingPage />],
      ['/studio', <StudioPage />],
      ['/plans', <PlansPage />],
      ['/about', <AboutPage />],
    ] as const) {
      server()
      const { container, unmount } = renderAt(path, [{ path, element }])
      await screen.findByRole('heading', { level: 1 })
      expect(container.textContent).not.toMatch(/\bmcp\b|claude|chatgpt|ai assistant|integration|developer/i)
      expect(document.head.innerHTML).not.toMatch(/\bmcp\b|claude|chatgpt|ai assistant/i)
      unmount()
    }
  })
})
