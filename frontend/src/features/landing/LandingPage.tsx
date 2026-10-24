import { useEffect } from 'react'
import { Link } from 'react-router'
import { useAuthConfig } from '@/hooks/useAuth'
import { JafatDefs } from './JafatDefs'
import './jafat.css'

const FONTS =
  'https://fonts.googleapis.com/css2?family=Aref+Ruqaa:wght@700&family=Cormorant+Garamond:wght@400;500;600&family=Gulzar&family=IM+Fell+English+SC&family=Sora:wght@500;600;800&display=swap'

// only the public site needs these faces, so they come and go with it
function useBrandFonts() {
  useEffect(() => {
    const pre = Object.assign(document.createElement('link'), { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: '' })
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: FONTS })
    document.head.append(pre, css)
    return () => {
      pre.remove()
      css.remove()
    }
  }, [])
}

const QUILL = '/brand/feather.svg'

const CRAFTS = [
  ['Pictures', 'Illustrations, covers and posters in your own style, from a single line.'],
  ['Video', 'Still pictures brought to life, then cut into a film with titles and music.'],
  ['Voices', 'Narration in English, Urdu and Swedish, with aerab where the words need it.'],
  ['Music', 'Scores and soundscapes for every story, made to fit its length.'],
]

const MORE = [
  ['Characters that keep their face and voice', 'Cast someone once; they look and sound the same in every scene.'],
  ['A whole film from one idea', 'A line becomes a script, a storyboard, shots, a score and a cut.'],
  ['Video podcasts with two hosts', 'Two voices talk your topic through, on screen, from your notes.'],
  ['Ads and print designs in your brand', 'Campaigns, posters and flyers in your colours, in every size.'],
  ['3D models from a picture or a line', 'Turn a sketch, a photo or a sentence into a model you can spin.'],
]

function Brand() {
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

export function LandingPage() {
  useBrandFonts()
  const config = useAuthConfig()
  // until the server answers, assume the door is open; an old server reads as closed (see useAuthConfig)
  const invite = config.data ? config.data.signup !== 'open' : false

  useEffect(() => {
    const was = document.title
    document.title = 'Jafat AI Studio: pictures, film, voices and music'
    return () => {
      document.title = was
    }
  }, [])

  const create = (label: string) =>
    invite ? (
      <Link className="btn btn-primary" to="/login">
        <img src={QUILL} alt="" />
        Sign in
      </Link>
    ) : (
      <Link className="btn btn-primary" to="/signup">
        <img src={QUILL} alt="" />
        {label}
      </Link>
    )

  return (
    <div className="jafat">
      <JafatDefs />
      <a className="skip" href="#main">
        Skip to content
      </a>

      <header className="band site-header">
        <Brand />
        <nav aria-label="Main">
          <a href="#studio">Studio</a>
          <a href="#how">How it works</a>
          <a href="#languages">Languages</a>
          <a href="#faq">FAQ</a>
        </nav>
        <Link className="btn btn-ghost" to="/login">
          Sign in
        </Link>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="hero" aria-labelledby="hero-title">
          <div className="reveal">
            <p className="eyebrow">Your own AI studio</p>
            <h1 id="hero-title">
              Every story, <span className="gilded">written in light</span>
            </h1>
            <p className="lede">
              Pictures, film, voices and music, made on Jafat’s own GPUs: in English,{' '}
              <span lang="ur" dir="rtl">
                اُردُو
              </span>{' '}
              and{' '}
              <span lang="ar" dir="rtl">
                العَرَبِيَّة
              </span>
              .
            </p>
            <div className="actions">
              {create('Start creating')}
              {invite ? (
                <span className="note">Sign-up is by invitation</span>
              ) : (
                <Link className="btn btn-ghost" to="/login">
                  Sign in
                </Link>
              )}
            </div>
          </div>
          <div className="hero-art reveal" aria-hidden>
            <span className="watermark ar">جعفت</span>
            <img className="quill" src={QUILL} alt="" />
          </div>
        </section>

        <section id="studio" aria-labelledby="studio-title">
          <div className="section-head">
            <p className="eyebrow">The studio</p>
            <h2 id="studio-title">Four crafts, one quill</h2>
            <p>Each tool is a page in the same old book: write the idea once, and the studio draws, films, voices and scores it.</p>
          </div>
          <div className="cards">
            {CRAFTS.map(([title, text]) => (
              <article key={title} className="card sheet reveal">
                <img className="icon" src={QUILL} alt="" />
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="sheet map more" aria-labelledby="more-title">
          <div className="section-head">
            <p className="eyebrow">Turn the page</p>
            <h2 id="more-title">More in the studio</h2>
          </div>
          <ul>
            {MORE.map(([title, text]) => (
              <li key={title}>
                <img src={QUILL} alt="" />
                <div>
                  <strong>{title}</strong>
                  <span>{text}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section id="how" aria-labelledby="how-title">
          <div className="section-head">
            <p className="eyebrow">How it works</p>
            <h2 id="how-title">Three strokes of the pen</h2>
          </div>
          <ol className="steps">
            <li>
              <span className="num ar gilded" aria-hidden>
                ١
              </span>
              <h3>Write your idea</h3>
              <p>A line, a verse or a page. Say who it’s for and how it should feel.</p>
            </li>
            <li>
              <span className="num ar gilded" aria-hidden>
                ٢
              </span>
              <h3>The studio drafts it</h3>
              <p>Pictures, shots, voices and music arrive as drafts you can look over.</p>
            </li>
            <li>
              <span className="num ar gilded" aria-hidden>
                ٣
              </span>
              <h3>Refine and export</h3>
              <p>Keep what you love, redo the rest, then take it away at full quality.</p>
            </li>
          </ol>
        </section>

        <section id="languages" aria-labelledby="languages-title">
          <div className="section-head">
            <p className="eyebrow">Languages</p>
            <h2 id="languages-title">Written as it is spoken</h2>
            <p>Each script set the right way round, and each voice reading it as a native speaker would.</p>
          </div>
          <div className="tongues">
            <div className="tongue sheet">
              <span className="name">English</span>
              <span className="sample" lang="en">
                Every story, written in light
              </span>
              <p>Scripts, subtitles and voices.</p>
            </div>
            <div className="tongue sheet">
              <span className="name">
                Urdu ·{' '}
                <span lang="ur" dir="rtl">
                  اُردُو
                </span>
              </span>
              <span className="sample ur" lang="ur" dir="rtl">
                ہَر کَہانی، نُور سے لِکھی ہُوئی
              </span>
              <p>With full aerab, so every word is read as it should sound.</p>
            </div>
            <div className="tongue sheet">
              <span className="name">
                Arabic ·{' '}
                <span lang="ar" dir="rtl">
                  العَرَبِيَّة
                </span>
              </span>
              <span className="sample" lang="ar" dir="rtl">
                كُلُّ حِكَايَةٍ مَكْتُوبَةٌ بِالنُّورِ
              </span>
              <p>Right to left, from the title card to the subtitles.</p>
            </div>
            <div className="tongue sheet">
              <span className="name">Swedish voices</span>
              <span className="sample" lang="sv">
                Varje berättelse, skriven i ljus
              </span>
              <p>Narration in warm Swedish voices.</p>
            </div>
          </div>
        </section>

        <section className="sheet yours" aria-labelledby="yours-title">
          <div>
            <p className="eyebrow">Private by default</p>
            <h2 id="yours-title">Your work stays yours</h2>
            <p>Nothing you write or make is handed to anyone else to train on, sell or look at.</p>
          </div>
          <ul>
            <li>
              <strong>Made on Jafat’s own GPUs</strong>
              <span>Every picture, frame and note is drawn on our own machines.</span>
            </li>
            <li>
              <strong>No third-party AI services</strong>
              <span>Your ideas never leave for someone else’s cloud.</span>
            </li>
            <li>
              <strong>Private until you share</strong>
              <span>Your library is yours alone unless you choose to show it.</span>
            </li>
          </ul>
        </section>

        <section id="faq" className="faq" aria-labelledby="faq-title">
          <div className="section-head">
            <p className="eyebrow">Questions</p>
            <h2 id="faq-title">Asked at the door</h2>
          </div>
          <details>
            <summary>Does an account cost anything?</summary>
            <p>
              {invite
                ? 'No. Accounts are free, and for now they are by invitation.'
                : 'No. A free account lets you try the whole studio; more room comes with Pro.'}
            </p>
          </details>
          <details>
            <summary>Which languages can I work in?</summary>
            <p>English, Urdu and Arabic, each in its own script, with full aerab on Urdu. Narration also comes in Swedish.</p>
          </details>
          <details>
            <summary>Who owns what I make?</summary>
            <p>You do. It stays in your private library until you decide to share it.</p>
          </details>
          <details>
            <summary>What do I need?</summary>
            <p>Only a web browser. The heavy work runs on Jafat’s own GPUs, so there is nothing to install.</p>
          </details>
          <details>
            <summary>How do I start?</summary>
            <p>
              {invite
                ? 'Sign in with the account you were invited to, then write your first idea.'
                : 'Create an account, confirm your email and write your first idea. The studio takes it from there.'}
            </p>
          </details>
        </section>

        <section className="sheet map finale" aria-labelledby="finale-title">
          <span className="ar gilded" lang="ar" aria-hidden>
            جعفت
          </span>
          <h2 id="finale-title">Begin your first page</h2>
          <p>{invite ? 'Sign-up is by invitation. Already have an account? Your studio is waiting.' : 'A free account lets you try the whole studio. Your work stays yours.'}</p>
          <div className="actions">{create('Create an account')}</div>
        </section>
      </main>

      <footer className="band site-footer">
        <span>© 2026 Jafat AI Studio · jafat.ai</span>
        <Link to="/login">Sign in</Link>
        {!invite && <Link to="/signup">Create an account</Link>}
      </footer>
    </div>
  )
}
