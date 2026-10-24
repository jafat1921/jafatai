import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import type { AuthConfig, User } from '@/lib/types'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { LoginPage } from '@/features/auth/LoginPage'

afterEach(() => vi.unstubAllGlobals())

const nia: User = { id: 'u2', email: 'nia@example.com', display_name: 'Nia', workspace_id: 'w2', role: 'owner', verified: true }

function server({ me = null, signup = 'open' }: { me?: User | null; signup?: AuthConfig['signup'] } = {}) {
  mockApi((_method, path) => {
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
    expect(await screen.findByRole('heading', { level: 1, name: /Every story, written in light/ })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(await screen.findByRole('link', { name: /Start creating/ })).toHaveAttribute('href', '/signup')
    const signIns = screen.getAllByRole('link', { name: 'Sign in' })
    expect(signIns.length).toBeGreaterThan(0)
    signIns.forEach((a) => expect(a).toHaveAttribute('href', '/login'))
    expect(screen.getAllByRole('link', { name: /Create an account/ })[0]).toHaveAttribute('href', '/signup')
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
    expect(screen.queryByRole('heading', { name: /written in light/ })).toBeNull()
  })

  it.each(['invite', 'closed'] as const)('offers only sign-in while sign-up is %s', async (signup) => {
    server({ signup })
    const { container } = visit('/')
    await screen.findByRole('heading', { level: 1 })
    expect((await screen.findAllByText('Sign-up is by invitation', { exact: false })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: /Create an account/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Start creating/ })).toBeNull()
    expect(container.querySelectorAll('a[href="/signup"]')).toHaveLength(0)
    screen.getAllByRole('link', { name: /Sign in/ }).forEach((a) => expect(a).toHaveAttribute('href', '/login'))
  })
})

describe('rebrand', () => {
  it('names Jafat AI Studio on the sign-in page', async () => {
    server()
    renderAt('/login', [{ path: '/login', element: <LoginPage /> }])
    expect(await screen.findByRole('heading', { level: 1, name: 'Jafat AI Studio' })).toBeInTheDocument()
  })
})
