import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import type { AuthConfig, User } from '@/lib/types'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { LoginPage } from '@/features/auth/LoginPage'
import { StudioPage } from './StudioPage'
import { PlansPage } from './PlansPage'
import { AboutPage } from './AboutPage'
import { PUBLIC_META } from './meta'
import { priceLabel } from './head'
import type { SitePlan } from '@/lib/api'

afterEach(() => vi.unstubAllGlobals())

const nia: User = { id: 'u2', email: 'nia@example.com', display_name: 'Nia', workspace_id: 'w2', role: 'owner', verified: true }

const plan = (over: Partial<SitePlan>): SitePlan => ({
  id: 'p',
  name: 'Plan',
  description: '',
  price_pkr: 0,
  period: 'month',
  days: null,
  private_items: false,
  studios: [],
  ...over,
})

const PLANS: SitePlan[] = [
  plan({ id: 'free', name: 'Free', description: 'Try the studio.', studios: ['Image studio', 'Video studio'] }),
  plan({
    id: 'creator',
    name: 'Creator',
    description: 'For people who make every week.',
    price_pkr: 2500,
    private_items: true,
    studios: ['Image studio', 'Video studio', 'Audio studio', 'Character studio', '3D studio', 'Ad studio', 'Photo studio', 'Print studio'],
  }),
  plan({ id: 'week', name: 'Week pass', price_pkr: 900, period: 'none', days: 7, studios: ['Image studio'] }),
]

function server({
  me = null,
  signup = 'open',
  plans = PLANS,
}: { me?: User | null; signup?: AuthConfig['signup']; plans?: SitePlan[] | Response } = {}) {
  mockApi((_method, path) => {
    if (path === '/site/plans') return plans
    if (path === '/auth/config') return { signup, google: false, verify: true }
    if (path === '/auth/dev-login') return { enabled: false }
    if (path === '/auth/me') return me ?? new Response(JSON.stringify({ detail: 'Not signed in' }), { status: 401 })
  })
}

function Where() {
  const loc = useLocation()
  return <output data-testid="location">{loc.pathname}</output>
}

// RequireAuth is a layout route, so this needs real nesting rather than renderAt's flat list
function visit(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<p>sign-in page</p>} />
          <Route path="/signup" element={<p>sign-up page</p>} />
          <Route path="/studio" element={<StudioPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route element={<RequireAuth />}>
            <Route index element={<p>studio home</p>} />
            <Route path="image/generate" element={<p>image page</p>} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('public site', () => {
  it('greets a signed-out visitor at / with the landing page', async () => {
    server()
    visit('/')
    expect(await screen.findByRole('heading', { level: 1, name: /Create stories \/ pictures \/ films \/ voices, made at Jafat/ })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    const starts = await screen.findAllByRole('link', { name: /Start creating/ })
    starts.forEach((a) => expect(a).toHaveAttribute('href', '/signup'))
    const signIns = screen.getAllByRole('link', { name: 'Sign in' })
    expect(signIns.length).toBeGreaterThan(0)
    signIns.forEach((a) => expect(a).toHaveAttribute('href', '/login'))
    expect(screen.getByRole('link', { name: /Create a free account/ })).toHaveAttribute('href', '/signup')
    expect(screen.getByRole('link', { name: 'See what people make' })).toHaveAttribute('href', '#gallery')
    expect(screen.getByRole('heading', { name: 'One idea, every format' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Made at Jafat' }).closest('section')).toHaveAttribute('id', 'gallery')
    for (const name of ['Pictures', 'Video', 'Story films', 'Voices', 'Music & sound', 'Characters', 'Ad campaigns', 'Print & products'])
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Explore: Characters' })).toHaveAttribute('href', '/studio#films')
    // the Urdu page of the two-language story is real text, not baked into a picture
    expect(screen.getByText('بادَل نے گاؤں کی مَدَد کرنے کا اِرادہ کیا۔').closest('[lang]')).toHaveAttribute('lang', 'ur')
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main')
    expect(screen.queryByText(/implant/i)).toBeNull()
  })

  it('still sends a signed-out visitor on a studio page to sign in', async () => {
    server()
    visit('/image/generate')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))
    expect(screen.getByText('sign-in page')).toBeInTheDocument()
  })

  it('keeps the studio home for someone signed in', async () => {
    server({ me: nia })
    visit('/')
    expect(await screen.findByText('studio home')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /made at Jafat/ })).toBeNull()
  })

  it.each(['invite', 'closed'] as const)('offers only sign-in while sign-up is %s', async (signup) => {
    server({ signup })
    const { container } = visit('/')
    await screen.findByRole('heading', { level: 1 })
    expect((await screen.findAllByText('Sign-up is by invitation', { exact: false })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: /Create a free account|Create account|Get started/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Start creating/ })).toBeNull()
    expect(container.querySelectorAll('a[href="/signup"]')).toHaveLength(0)
    screen.getAllByRole('link', { name: /Sign in/ }).forEach((a) => expect(a).toHaveAttribute('href', '/login'))
  })
})

const PUBLIC = ['/', '/studio', '/plans', '/about']

describe('public pages', () => {
  it.each(PUBLIC)('%s renders for a visitor, with one h1 and nothing technical', async (path) => {
    server()
    const { container } = visit(path)
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/gpu|server|self-hosted|ideogram|\bltx\b|\bwan\b|qwen|z-image|implant/i)
    // every picture either says what it shows or is marked as decoration
    container.querySelectorAll('img').forEach((img) => expect(img.hasAttribute('alt')).toBe(true))
  })

  it('points the header at the studio sections, the gallery and the prices', async () => {
    server()
    visit('/plans')
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Pictures', '/studio#pictures'],
      ['Video', '/studio#video'],
      ['Voices', '/studio#voices'],
      ['Music', '/studio#music'],
      ['Characters', '/studio#characters'],
      ['Library', '/#gallery'],
      ['Pricing', '/plans'],
    ])
    expect(within(nav).getByRole('link', { name: 'Pricing' })).toHaveAttribute('aria-current', 'page')
  })

  it('gives /studio the sections the header links to', async () => {
    server()
    const { container } = visit('/studio')
    await screen.findByRole('heading', { level: 1 })
    for (const id of ['pictures', 'video', 'voices', 'music', 'characters']) expect(container.querySelector(`#${id}`)).not.toBeNull()
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives each page its own title, description and structured data', async () => {
    const seen = new Set<string>()
    for (const path of PUBLIC) {
      server()
      const { unmount } = visit(path)
      await screen.findByRole('heading', { level: 1 })
      const meta = PUBLIC_META.find((m) => m.path === path)!
      expect(document.title).toBe(meta.title)
      expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(meta.description)
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://jafat.ai${path}`)
      const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!)
      const types = ld['@graph'].map((n: { '@type': string }) => n['@type'])
      expect(types).toEqual(expect.arrayContaining(['Organization', 'WebSite', 'SoftwareApplication']))
      if (meta.faq) expect(types).toContain('FAQPage')
      expect(meta.title.length).toBeLessThanOrEqual(60)
      expect(meta.description.length).toBeGreaterThanOrEqual(140)
      expect(meta.description.length).toBeLessThanOrEqual(160)
      expect(meta.title + meta.description).not.toMatch(/gpu/i)
      seen.add(meta.title).add(meta.description)
      unmount()
      expect(document.querySelector('script[type="application/ld+json"]')).toBeNull()
    }
    expect(seen.size).toBe(PUBLIC.length * 2)
  })

  it('prices the plans the admin put on the website, with the middle one marked', async () => {
    server()
    visit('/plans')
    expect(await screen.findByText('Rs 2,500 / month')).toBeInTheDocument()
    const cards = screen.getAllByRole('heading', { level: 3 })
    expect(cards.map((h) => h.textContent)).toEqual(['Free', 'Creator', 'Week pass'])
    expect(screen.getByText('Rs 900 for 7 days')).toBeInTheDocument()
    expect(screen.getByText('For people who make every week.')).toBeInTheDocument()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(screen.getAllByText('Private work')).toHaveLength(1)
    expect(screen.getByText('Most chosen').closest('li')).toHaveTextContent('Creator')
    screen.getAllByRole('link', { name: /Get started with/ }).forEach((a) => expect(a).toHaveAttribute('href', '/signup'))
    expect(document.body.textContent).not.toMatch(/credits|minutes|limit/i)
  })

  it('marks no plan as most chosen when there are only two', async () => {
    server({ plans: PLANS.slice(0, 2) })
    visit('/')
    await screen.findByRole('link', { name: 'Get started with Creator' })
    expect(screen.queryByText('Most chosen')).toBeNull()
  })

  it.each([
    ['empty', () => []],
    ['failing', () => new Response('{}', { status: 500 })],
  ] as const)('says plans are coming when the list is %s', async (_label, make) => {
    server({ plans: make() as SitePlan[] | Response })
    visit('/plans')
    expect(await screen.findByText(/Plans are being prepared/)).toBeInTheDocument()
  })

  it('sends plan buttons to sign-in while sign-up is closed', async () => {
    server({ signup: 'closed' })
    visit('/plans')
    await screen.findByText('Rs 2,500 / month')
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Sign in with/ })).toHaveLength(3))
    screen.getAllByRole('link', { name: /Sign in with/ }).forEach((a) => expect(a).toHaveAttribute('href', '/login'))
  })

  it('writes prices the way people here read them', () => {
    expect(priceLabel({ price_pkr: 0, period: 'month', days: null })).toBe('Rs 0')
    expect(priceLabel({ price_pkr: 12500, period: 'year', days: null })).toBe('Rs 12,500 / year')
    expect(priceLabel({ price_pkr: 300, period: 'none', days: 1 })).toBe('Rs 300 for 1 day')
    expect(priceLabel({ price_pkr: 300, period: 'none', days: null })).toBe('Rs 300, one-off')
  })

  it('opens and closes the menu button for small screens', async () => {
    server()
    visit('/plans')
    const menu = await screen.findByRole('button', { name: 'Menu' })
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    const user = userEvent.setup()
    await user.click(menu)
    expect(menu).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(menu).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the public pages to someone signed in, with a way back to the studio', async () => {
    server({ me: nia })
    visit('/studio')
    const back = await screen.findAllByRole('link', { name: 'Open your studio' })
    back.forEach((a) => expect(a).toHaveAttribute('href', '/'))
    expect(screen.queryByRole('link', { name: 'Start creating' })).toBeNull()
  })

  it.each(['/studio', '/plans', '/about'])('%s offers no sign-up while it is closed', async (path) => {
    server({ signup: 'closed' })
    const { container } = visit(path)
    await screen.findByRole('heading', { level: 1 })
    await waitFor(() => expect(container.querySelectorAll('a[href="/signup"]')).toHaveLength(0))
  })
})

describe('rebrand', () => {
  it('names Jafat AI Studio on the sign-in page, with the logo and a way back', async () => {
    server()
    renderAt('/login', [{ path: '/login', element: <LoginPage /> }])
    expect(await screen.findByRole('heading', { level: 1, name: 'Jafat AI Studio' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Jafat logo' })).toHaveAttribute('src', '/brand/jafat-logo-horizontal-light.png')
    expect(screen.getByRole('link', { name: /Back to jafat.ai/ })).toHaveAttribute('href', '/')
    expect(document.body.textContent).not.toMatch(/gpu/i)
  })
})
