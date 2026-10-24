import { Link } from 'react-router'
import { Check, ChevronRight, Mic } from 'lucide-react'
import { QUILL, priceLabel, useCreateHref, useSitePlans } from './head'

const STORY = '/brand/story/'

// the pictures arrive by hand, so a missing one leaves the parchment frame rather than a broken icon
export function Pic({ name, alt, className, play, eager }: { name: string; alt: string; className?: string; play?: boolean; eager?: boolean }) {
  return (
    <span className={className ? `pic ${className}` : 'pic'}>
      <img
        src={`${STORY}${name}.webp`}
        alt={alt}
        width={1024}
        height={768}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
      />
      {play && <span className="play" aria-hidden />}
    </span>
  )
}

// a made-up but steady shape; random heights would change on every render
const BARS = [3, 5, 8, 4, 9, 12, 7, 10, 14, 9, 6, 11, 15, 10, 7, 12, 8, 5, 9, 6, 4, 7, 3, 5]

export function Wave({ className }: { className?: string }) {
  return (
    <span className={className ? `wave ${className}` : 'wave'} aria-hidden>
      {BARS.map((h, i) => (
        <span key={i} style={{ height: `${h * 6}%` }} />
      ))}
    </span>
  )
}

export function VoiceCard({ mic, className }: { mic?: boolean; className?: string }) {
  return (
    <span className={className ? `pic dark ${className}` : 'pic dark'} aria-hidden>
      <Wave />
      {mic && (
        <span className="mic">
          <Mic />
        </span>
      )}
    </span>
  )
}

interface Tile {
  id: string
  title: string
  line: string
  group: string
}

const TILES: Tile[] = [
  { id: 'pictures', title: 'Pictures', line: 'Create, edit with words, restyle, upscale, remove backgrounds.', group: 'photos' },
  { id: 'video', title: 'Video', line: 'Bring any picture to life, image to video.', group: 'films' },
  { id: 'story-films', title: 'Story films', line: 'Narrated storybook videos with captions, chapters and a quiz ending.', group: 'films' },
  { id: 'voices', title: 'Voices', line: 'Natural narration, design a voice, English and Urdu with correct aerab.', group: 'podcasts' },
  { id: 'music', title: 'Music & sound', line: 'Songs, background scores, sound effects.', group: 'sound' },
  { id: 'characters', title: 'Characters', line: 'One face and voice, consistent in every scene.', group: 'films' },
  { id: 'ads', title: 'Ad campaigns', line: 'Posts and short videos for WhatsApp, Facebook, Instagram and TikTok in every size.', group: 'social' },
  { id: 'print', title: 'Print & products', line: 'Posters, book covers, merchandise designs.', group: 'photos' },
]

/** The eight studio cards. On /studio they carry the ids the header links to. */
export function StudioTiles({ anchors }: { anchors?: boolean }) {
  return (
    <ul className="tiles" role="list">
      {TILES.map((t) => (
        <li key={t.id} id={anchors ? t.id : undefined} className="tile">
          <img className="tile-quill" src={QUILL} alt="" />
          <h3>{t.title}</h3>
          <p>{t.line}</p>
          <Link className="explore" to={anchors ? `#${t.group}` : `/studio#${t.group}`}>
            Explore<span className="sr-only">: {t.title}</span> <span aria-hidden>→</span>
          </Link>
          <ChevronRight className="chev" aria-hidden />
        </li>
      ))}
    </ul>
  )
}

const SHOWN = 6

export function PricingCards() {
  const to = useCreateHref()
  const plans = useSitePlans()

  if (plans.isPending) {
    return (
      <div className="pricing" role="status">
        <span className="sr-only">Loading plans…</span>
        {[0, 1, 2].map((i) => (
          <span key={i} className="price skeleton" aria-hidden />
        ))}
      </div>
    )
  }
  if (plans.isError || !plans.data.length) {
    return <p className="plans-empty">Plans are being prepared — create a free account to start.</p>
  }

  const list = plans.data
  const star = list.length >= 3 ? Math.floor((list.length - 1) / 2) : -1
  const action = to === '/' ? 'Open your studio' : to === '/login' ? 'Sign in' : 'Get started'

  return (
    <ul className="pricing" role="list">
      {list.map((p, i) => {
        const ticks = p.studios.slice(0, SHOWN)
        const extra = p.studios.length - SHOWN
        return (
          <li key={p.id} className={i === star ? 'price star' : 'price'}>
            {i === star && <span className="ribbon">Most chosen</span>}
            <div className="price-head">
              <h3>{p.name}</h3>
              <p className="amount">{priceLabel(p)}</p>
              {p.description && <p className="credits">{p.description}</p>}
            </div>
            <ul className="ticks">
              {ticks.map((f) => (
                <li key={f}>
                  <Check aria-hidden />
                  {f}
                </li>
              ))}
              {extra > 0 && <li className="more">+{extra} more</li>}
              {p.private_items && (
                <li>
                  <Check aria-hidden />
                  Private work
                </li>
              )}
            </ul>
            <Link className={i === star ? 'btn btn-primary pill' : 'btn btn-ghost pill'} to={to}>
              {action}{' '}
              <span className="sr-only">with {p.name}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
