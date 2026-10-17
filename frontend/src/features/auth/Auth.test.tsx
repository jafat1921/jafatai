import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import type { AuthConfig, User } from '@/lib/types'
import { LoginPage } from './LoginPage'
import { SignUpPage } from './SignUpPage'
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './PasswordPages'
import { passwordStrength } from './AuthLayout'

afterEach(() => vi.unstubAllGlobals())

const open: AuthConfig = { signup: 'open', google: false, verify: true }
const nia: User = { id: 'u2', email: 'nia@example.com', display_name: 'Nia', workspace_id: 'w2', role: 'owner', verified: true }

function signedOut(handler: (method: string, path: string, body: unknown) => unknown = () => undefined, config = open) {
  const calls = mockApi((method, path, _q, body) => {
    const hit = handler(method, path, body)
    if (hit !== undefined) return hit
    if (path === '/auth/config') return config
    if (path === '/auth/dev-login') return { enabled: false }
    if (path === '/auth/me') return new Response(JSON.stringify({ detail: 'Not signed in' }), { status: 401 })
  })
  return calls
}

const routes = [
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignUpPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/', element: <p>studio home</p> },
]

describe('sign in', () => {
  it('links to forgot password and, while sign-up is open, to a new account', async () => {
    signedOut()
    renderAt('/login', routes)
    expect(await screen.findByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/signup')
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password')
  })

  it('hides the sign-up link when accounts are by invitation', async () => {
    signedOut(() => undefined, { ...open, signup: 'invite' })
    renderAt('/login', routes)
    await screen.findByRole('link', { name: 'Forgot password?' })
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Create an account' })).toBeNull())
  })

  it('says the email is confirmed after a second open of the link', async () => {
    signedOut()
    renderAt('/login?verified=1', routes)
    expect(await screen.findByText(/Your email is confirmed/)).toBeInTheDocument()
  })

  it('shows why a switched-off account is refused', async () => {
    signedOut((method, path) => {
      if (method === 'POST' && path === '/auth/login')
        return new Response(JSON.stringify({ detail: "This account has been switched off. Ask the studio's admin." }), { status: 403 })
    })
    renderAt('/login', routes)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'nia@example.com')
    await user.type(screen.getByLabelText('Password'), 'whatever-long')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('switched off')
  })
})

describe('sign up', () => {
  it('rates the password and only submits a long enough one', async () => {
    expect(passwordStrength('short').level).toBe(0)
    expect(passwordStrength('abcdefghij').level).toBe(1)
    expect(passwordStrength('Correct-Horse-Battery-9').label).toBe('Strong')

    const calls = signedOut((method, path) => {
      if (method === 'POST' && path === '/auth/signup') return { detail: 'ok' }
      if (method === 'POST' && path === '/auth/verify/resend') return { detail: 'ok' }
    })
    renderAt('/signup', routes)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Name'), 'Nia')
    await user.type(screen.getByLabelText('Email'), 'nia@example.com')
    await user.type(screen.getByLabelText('Password'), 'short')
    expect(screen.getByText('5 more characters to go')).toBeInTheDocument()
    const create = screen.getByRole('button', { name: 'Create account' })
    expect(create).toBeDisabled()
    await user.type(screen.getByLabelText('Password'), '-and-longer')
    await user.click(create)

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/auth/signup')?.body).toEqual({ name: 'Nia', email: 'nia@example.com', password: 'short-and-longer' })
    await user.click(screen.getByRole('button', { name: 'Send the link again' }))
    expect(await screen.findByText(/Sent again/)).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/auth/verify/resend')?.body).toEqual({ email: 'nia@example.com' })
  })

  it('explains when sign-up is closed', async () => {
    signedOut(() => undefined, { ...open, signup: 'closed' })
    renderAt('/signup', routes)
    expect(await screen.findByText('Sign-up is closed at the moment.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })
})

describe('password reset', () => {
  it('asks for an email and gives the same answer either way', async () => {
    const calls = signedOut((method, path) => {
      if (method === 'POST' && path === '/auth/forgot') return { detail: 'ok' }
    })
    renderAt('/forgot-password', routes)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'who@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText(/If there’s an account for that address/)).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/auth/forgot')?.body).toEqual({ email: 'who@example.com' })
  })

  it('checks the two passwords match, then signs in', async () => {
    const calls = signedOut((method, path) => {
      if (method === 'POST' && path === '/auth/reset') return nia
    })
    renderAt('/reset-password?token=tok123', routes)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('New password'), 'brand-new-pass-1')
    await user.type(screen.getByLabelText('Type it again'), 'brand-new-pass-2')
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('don’t match')
    expect(calls.some((c) => c.path === '/auth/reset')).toBe(false)

    await user.clear(screen.getByLabelText('Type it again'))
    await user.type(screen.getByLabelText('Type it again'), 'brand-new-pass-1')
    await user.click(screen.getByRole('button', { name: 'Save and sign in' }))
    expect(await screen.findByText('studio home')).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/auth/reset')?.body).toEqual({ token: 'tok123', password: 'brand-new-pass-1' })
  })

  it('offers a new link when this one has expired, and words an invite differently', async () => {
    signedOut((method, path) => {
      if (method === 'POST' && path === '/auth/reset')
        return new Response(JSON.stringify({ detail: 'This link has expired or has already been used. Ask for a new one.' }), { status: 400 })
    })
    renderAt('/reset-password?token=old&invite=1', routes)
    expect(screen.getByText('Choose your password')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('New password'), 'brand-new-pass-1')
    await user.type(screen.getByLabelText('Type it again'), 'brand-new-pass-1')
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('expired')
    expect(screen.getByRole('link', { name: 'Send a new link' })).toHaveAttribute('href', '/forgot-password')
  })

  it('a stale confirm link can ask for a fresh one', async () => {
    const calls = signedOut((method, path) => {
      if (method === 'POST' && path === '/auth/verify/resend') return { detail: 'ok' }
    })
    renderAt('/verify-email?status=expired', routes)
    const user = userEvent.setup()
    expect(await screen.findByText(/expired or has already been used/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Email'), 'nia@example.com')
    await user.click(screen.getByRole('button', { name: 'Send a new link' }))
    expect(await screen.findByText(/a new link is on its way/)).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/auth/verify/resend')?.body).toEqual({ email: 'nia@example.com' })
  })
})
