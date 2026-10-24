import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { useMe } from '@/hooks/useAuth'
import { JafatDefs } from './JafatDefs'
import { QUILL, useBrandFonts, useCreateHref, useInviteOnly } from './head'
import './jafat.css'

const CRAFTS: [string, string][] = [
  ['/studio#pictures', 'Pictures'],
  ['/studio#video', 'Video'],
  ['/studio#voices', 'Voices'],
  ['/studio#music', 'Music'],
  ['/studio#characters', 'Characters'],
]

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="Jafat AI Studio, home">
      <span className="ar gilded" lang="ar" aria-hidden>
        جعفت
      </span>
      <span aria-hidden>
        <b>JAFAT</b>
        <small className="gilded">AI STUDIO</small>
      </span>
    </Link>
  )
}

/** The call to action every page ends on. */
export function CreateButton({ label = 'Start creating', arrow }: { label?: string; arrow?: boolean }) {
  const to = useCreateHref()
  return (
    <Link className="btn btn-primary pill" to={to}>
      {to === '/' ? 'Open your studio' : to === '/login' ? 'Sign in' : label}
      {arrow && <span aria-hidden>→</span>}
    </Link>
  )
}

// the router leaves #anchors alone, so the header's /studio#voices links need a nudge
function useHashScroll() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (!hash) return
    const el = document.getElementById(decodeURIComponent(hash.slice(1)))
    el?.scrollIntoView?.({ block: 'start' })
  }, [pathname, hash])
}

export function MarketingLayout({ children, className }: { children: React.ReactNode; className?: string }) {
  useBrandFonts()
  useHashScroll()
  const invite = useInviteOnly()
  const me = useMe()
  const [open, setOpen] = useState(false)

  const account = me.data ? (
    <Link className="btn btn-primary pill" to="/">
      Open your studio
    </Link>
  ) : (
    <>
      <Link className="btn btn-ghost pill" to="/login">
        Sign in
      </Link>
      {!invite && (
        <Link className="btn btn-primary pill" to="/signup">
          Start creating
        </Link>
      )}
    </>
  )

  return (
    <div className={className ? `jafat ${className}` : 'jafat'}>
      <JafatDefs />
      <a className="skip" href="#main">
        Skip to content
      </a>

      <header
        className="band site-header"
        data-open={open || undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        <Brand />
        <img className="head-quill" src={QUILL} alt="" />
        <button type="button" className="menu-btn" aria-expanded={open} aria-controls="site-menu" onClick={() => setOpen((o) => !o)}>
          <span className="burger" aria-hidden />
          <span className="sr-only">Menu</span>
        </button>
        <div
          id="site-menu"
          className="site-menu"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a')) setOpen(false)
          }}
        >
          <nav aria-label="Main">
            {CRAFTS.map(([to, label]) => (
              <Link key={to} to={to}>
                {label}
              </Link>
            ))}
            <Link to="/#gallery">Library</Link>
            <NavLink to="/plans">Pricing</NavLink>
          </nav>
          <div className="account">{account}</div>
        </div>
      </header>

      <main id="main" className="site-main" tabIndex={-1}>
        {children}
      </main>

      <footer className="site-footer">
        <div className="foot-brand">
          <Brand />
        </div>
        <nav className="foot-cols" aria-label="Footer">
          <div>
            <h2>Studio</h2>
            {CRAFTS.map(([to, label]) => (
              <Link key={to} to={to}>
                {label}
              </Link>
            ))}
          </div>
          <div>
            <h2>Company</h2>
            <NavLink to="/about">About</NavLink>
            <NavLink to="/plans">Pricing</NavLink>
          </div>
          <div>
            <h2>Account</h2>
            {me.data ? (
              <Link to="/">Open your studio</Link>
            ) : (
              <>
                <Link to="/login">Sign in</Link>
                {!invite && <Link to="/signup">Create account</Link>}
              </>
            )}
          </div>
        </nav>
        <p className="copy">© 2026 Jafat AI Studio · jafat.ai</p>
      </footer>
    </div>
  )
}
