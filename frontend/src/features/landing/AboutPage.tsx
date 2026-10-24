import { CreateButton, MarketingLayout } from './MarketingLayout'
import { usePageMeta } from './head'
import { ABOUT_META } from './meta'

export function AboutPage() {
  usePageMeta(ABOUT_META)
  return (
    <MarketingLayout>
      <section className="page-head" aria-labelledby="about-title">
        <p className="eyebrow">About us</p>
        <h1 id="about-title">A creative AI studio for Urdu and English storytellers</h1>
        <p className="lede">
          Most AI tools treat Urdu as an afterthought. Jafat starts with them: a studio where a poem, a shop’s offer or a
          family story can become a picture, a film, a voice or a song, written the way it should be.
        </p>
      </section>

      <div className="about">
        <section className="sheet" aria-labelledby="about-languages">
          <h2 id="about-languages">Two languages, one studio</h2>
          <p>
            Work in English,{' '}
            <span lang="ur" dir="rtl">
              اُردُو
            </span>
            . Urdu is set in Nastaliq with full aerab, right to left from title card to subtitle, and every voice reads as a native speaker
            would.
          </p>
        </section>

        <section className="sheet" aria-labelledby="about-private">
          <h2 id="about-private">Private by default</h2>
          <p>
            Everything is made in Jafat’s own studio. What you write and make is never handed to anyone else to train on, sell or look at, and
            your library stays yours until you choose to share it.
          </p>
        </section>

        <section className="sheet" aria-labelledby="about-name">
          <h2 id="about-name">The name</h2>
          <p>
            We write it{' '}
            <span className="ar-inline" lang="ar" dir="rtl">
              جَعْفَت
            </span>{' '}
            and say it Ja’fat. We wanted a name that looks as lovely in Urdu script as it sounds, and that carries the feel of an old
            manuscript: ink, parchment and gold.
          </p>
        </section>
      </div>

      <section className="sheet map finale" aria-labelledby="about-finale">
        <h2 id="about-finale">Write your first page</h2>
        <p>Start free and see what your idea becomes.</p>
        <div className="actions">
          <CreateButton />
        </div>
      </section>
    </MarketingLayout>
  )
}
