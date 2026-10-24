import { Link } from 'react-router'
import { MessageSquare, Sparkles } from 'lucide-react'
import { CreateButton, MarketingLayout } from './MarketingLayout'
import { Pic, PricingCards, StudioTiles, VoiceCard } from './parts'
import { QUILL, useCreateHref, useInviteOnly, usePageMeta } from './head'
import { HOME_META } from './meta'

const UR = (text: string) => (
  <span lang="ur" dir="rtl">
    {text}
  </span>
)

const GALLERY: [string, string, boolean?][] = [
  ['girl_book', 'Storybook illustration of a girl reading, the same character on every page'],
  ['castle', 'AI image of a fairy-tale castle above a green valley'],
  ['kingfisher', 'Short AI video of a kingfisher on a branch', true],
  ['elder', 'Portrait of a wise elder with a white beard and a turban'],
  ['neon_city', 'A neon city at night, made with the AI image generator'],
  ['music_notes', 'Glowing music notes for an original AI soundtrack'],
  ['dream_big', 'Poster with the words Dream Big set in exact lettering'],
  ['family_story', 'A family story told in warm illustrated pictures'],
  ['mountain_village', 'A mountain village at dawn, painted from one line of text'],
]

const PIPELINE = ['Title card', 'Scenes', 'Narration', 'Music', 'The End']

export function LandingPage() {
  usePageMeta(HOME_META)
  const invite = useInviteOnly()
  const create = useCreateHref()

  return (
    <MarketingLayout>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy reveal">
          <p className="eyebrow">Your AI studio</p>
          <h1 id="hero-title">
            Create stories / <span className="gilded">pictures</span> / <span className="gilded">films</span> /{' '}
            <span className="gilded">voices</span>, made at Jafat.
          </h1>
          <p className="lede">
            Write the idea once. Jafat draws it, films it, voices it and scores it, in English and {UR('اُردُو')}.
          </p>
          <div className="actions">
            <CreateButton label="Start creating free" arrow />
            <a className="btn btn-ghost pill" href="#gallery">
              See what people make
            </a>
            {invite && <span className="note">Sign-up is by invitation</span>}
          </div>
        </div>
        <div className="hero-art reveal" aria-hidden>
          <img className="quill" src={QUILL} alt="" />
          <Pic name="castle" alt="" className="h1" eager />
          <Pic name="forest" alt="" className="h2" play eager />
          <VoiceCard className="h3" />
          <VoiceCard className="h4" />
        </div>
      </section>

      <section className="sheet formats" aria-labelledby="formats-title">
        <h2 id="formats-title">One idea, every format</h2>
        <Link className="prompt" to={create} aria-label="Try your own idea">
          <img src={QUILL} alt="" />
          <span className="prompt-text">A little cloud who wants to help…</span>
          <span className="go" aria-hidden>
            →
          </span>
        </Link>
        <ol className="flow">
          <li>
            <Pic name="cloud" alt="AI image generator: a smiling little cloud, from a single idea" />
            <h3>Picture</h3>
            <p>From your idea to beautiful images.</p>
          </li>
          <li>
            <Pic name="forest" alt="AI video of a sunlit forest, made from the picture" play />
            <h3>Film</h3>
            <p>Turn images into short films.</p>
          </li>
          <li>
            <VoiceCard mic />
            <h3>Narration</h3>
            <p>Natural voices in English and {UR('اُردُو')}.</p>
          </li>
          <li>
            <Pic name="music_notes" alt="Glowing music notes for original AI music" />
            <h3>Music</h3>
            <p>Original music and soundscapes.</p>
          </li>
        </ol>
      </section>

      <section className="studio" aria-labelledby="studio-title">
        <div className="head-left">
          <h2 id="studio-title">The Studio</h2>
          <p>Everything you need to create, in one place.</p>
        </div>
        <StudioTiles />
      </section>

      <div className="two-up">
        <section className="sheet char" aria-labelledby="char-title">
          <Pic name="girl_book" alt="The same storybook character, a girl with a book, kept across every page" />
          <div>
            <h2 id="char-title">Same character, every page</h2>
            <p>The face and look are kept across a whole book.</p>
            <Link className="explore-inline" to="/studio#characters">
              Explore{' '}<span className="sr-only">characters</span> <span aria-hidden>→</span>
            </Link>
          </div>
        </section>
        <section className="sheet script-film" aria-labelledby="film-title">
          <h2 id="film-title">From script to film</h2>
          <p>Your story, from idea to screen.</p>
          <ol className="pipeline">
            {PIPELINE.map((step) => (
              <li key={step}>
                {step === 'Title card' && (
                  <span className="pic dark gold-text" aria-hidden>
                    Title
                  </span>
                )}
                {step === 'Scenes' && <Pic name="castle" alt="" />}
                {step === 'Narration' && <VoiceCard />}
                {step === 'Music' && <Pic name="music_notes" alt="" />}
                {step === 'The End' && (
                  <span className="pic dark gold-text" aria-hidden>
                    The End
                  </span>
                )}
                <span className="step">{step}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="two-up">
        <section className="sheet brand-kit" aria-labelledby="brand-title">
          <h2 id="brand-title">Your brand, kept</h2>
          <p>Your brand kit, applied to every output.</p>
          <div className="kit" aria-hidden>
            <span className="kit-logo">
              <img src={QUILL} alt="" />
              YOUR BRAND
            </span>
            <span className="kit-side">
              <span className="dots">
                <i style={{ background: '#d4a017' }} />
                <i style={{ background: '#e8a33d' }} />
                <i style={{ background: '#3a8f8a' }} />
                <i style={{ background: '#3b3530' }} />
              </span>
              <span className="aa">
                Aa <span>Aa</span>
              </span>
              <span className="kit-cap">Colours · Fonts · Voice</span>
            </span>
          </div>
        </section>
        <section className="sheet speaks" aria-labelledby="speaks-title">
          <h2 id="speaks-title">Speaks your language</h2>
          <p>Same story, two languages.</p>
          <div className="pair">
            <figure>
              <div className="page" lang="en">
                <Pic name="cloud" alt="The little cloud, from an English storybook page" />
                <span className="pg-lang">English</span>
                <strong>The Little Cloud</strong>
                <span>The cloud wanted to help the village.</span>
              </div>
              <figcaption>English</figcaption>
            </figure>
            <figure>
              <div className="page ur-page" lang="ur" dir="rtl">
                <Pic name="cloud" alt="The little cloud on an Urdu storybook page" />
                <strong>چھوٹا سا بادَل</strong>
                <span>بادَل نے گاؤں کی مَدَد کرنے کا اِرادہ کیا۔</span>
              </div>
              <figcaption lang="ur" dir="rtl">
                اُردُو
              </figcaption>
            </figure>
          </div>
        </section>
      </div>

      <section id="gallery" className="sheet made" aria-labelledby="gallery-title">
        <h2 id="gallery-title">Made at Jafat</h2>
        <p>Real examples. Endless possibilities.</p>
        <ul className="polaroids" role="list" aria-label="Examples made at Jafat" tabIndex={0}>
          {GALLERY.map(([name, alt, play]) => (
            <li key={name}>
              <Pic name={name} alt={alt} play={play} />
            </li>
          ))}
        </ul>
      </section>

      <section className="sheet works" aria-labelledby="works-title">
        <div>
          <h2 id="works-title">Works where you work</h2>
          <p>Connect Jafat to your AI assistant in a minute.</p>
        </div>
        <ul className="chips" role="list">
          <li>
            <Sparkles aria-hidden />
            Claude
          </li>
          <li>
            <MessageSquare aria-hidden />
            ChatGPT
          </li>
          <li className="muted">More coming soon</li>
        </ul>
      </section>

      <section className="sheet price-band" aria-labelledby="price-title">
        <h2 id="price-title">Simple, fair pricing</h2>
        <p>More room. More possibilities.</p>
        <PricingCards />
      </section>

      <section className="scroll-cta" aria-labelledby="finale-title">
        <img className="cta-quill" src={QUILL} alt="" />
        <span className="ar gilded" lang="ar" aria-hidden>
          جعفت
        </span>
        <h2 id="finale-title">Begin your first page</h2>
        <CreateButton label="Create a free account" arrow />
      </section>
    </MarketingLayout>
  )
}
