import { CreateButton, MarketingLayout } from './MarketingLayout'
import { QUILL, usePageMeta } from './head'
import { StudioTiles } from './parts'
import { STUDIO_META } from './meta'

interface Group {
  id: string
  eyebrow: string
  title: string
  intro: React.ReactNode
  items: [string, string][]
}

const GROUPS: Group[] = [
  {
    id: 'social',
    eyebrow: 'Shops and brands',
    title: 'Grow your shop on social',
    intro: 'AI ads for Instagram, TikTok, Facebook and WhatsApp, made in your colours and with your logo, in English or Urdu.',
    items: [
      ['Social ads and posts', 'Describe the offer once and get a set of posts, stories and reels, each sized for its feed.'],
      ['Your brand kit', 'Keep your colours, fonts and logo in one place, and every design follows them.'],
      ['Product photos for online shops', 'Clean, bright shots of what you sell, on a backdrop that suits it.'],
      ['Posters and covers with exact text', 'Headlines, prices and dates spelt just as you wrote them.'],
    ],
  },
  {
    id: 'languages',
    eyebrow: 'Our languages',
    title: 'Urdu, done right',
    intro: (
      <>
        Proper script, not a font swapped in at the end:{' '}
        <span lang="ur" dir="rtl">
          اُردُو
        </span>{' '}
        in Nastaliq, with full aerab.
      </>
    ),
    items: [
      ['Nastaliq for Urdu', 'Titles, posters and subtitles set in the flowing hand Urdu readers expect.'],
      ['Full aerab', 'Every vowel mark in place, so each word reads and sounds as it should.'],
      ['Right to left, everywhere', 'Title cards, captions and subtitles run the right way round.'],
      ['Urdu calligraphy', 'Verses and names written as lettering worthy of a frame.'],
    ],
  },
  {
    id: 'films',
    eyebrow: 'AI video maker in Urdu',
    title: 'Films, poetry and presenters',
    intro: 'From a single line to a finished film, with titles, music and a cast that stays true from scene to scene.',
    items: [
      ['A whole film from one idea', 'A line becomes a script, a storyboard, shots, a score and a cut.'],
      ['Urdu poetry videos', 'A poem turned into a short video, with a voice reading it, music beneath and the verses in calligraphy.'],
      ['Presenters who speak', 'Explainers and lessons fronted by a character whose lips move with the words.'],
      ['Characters that stay themselves', 'Cast someone once; they keep the same face and voice in everything you make.'],
      ['Pictures brought to life', 'Give a still picture movement, then cut it into your film.'],
    ],
  },
  {
    id: 'dubbing',
    eyebrow: 'Dubbing and subtitles',
    title: 'AI dubbing in Urdu and English',
    intro: 'Take a video to a new audience without filming it again.',
    items: [
      ['Dub a video', 'Translate what is said and re-voice it in Urdu or English.'],
      ['Transcribe and subtitle', 'Timed text and subtitle files from any recording, ready to upload.'],
    ],
  },
  {
    id: 'podcasts',
    eyebrow: 'Podcasts and voices',
    title: 'AI podcasts and Urdu voice-overs',
    intro: 'Natural text to speech in Urdu and English, for narration, characters and whole shows.',
    items: [
      ['Audio podcasts', 'Give it a topic or an article; get a written, voiced episode ready to publish.'],
      ['Video podcasts with two hosts', 'Turn an episode into a video, with two hosts talking it through on screen.'],
      ['Narration and character voices', 'Warm, natural voices for stories, lessons and ads.'],
      ['Design a voice', 'Describe the voice you hear in your head, and keep it for every project.'],
    ],
  },
  {
    id: 'sound',
    eyebrow: 'Music and sound',
    title: 'Songs, scores and sound effects',
    intro: 'Music made to fit your story, to the second.',
    items: [
      ['Songs with lyrics', 'Write the words, choose the mood, and hear them sung.'],
      ['Music and score', 'Backing tracks and cues for films, reels and podcasts.'],
      ['Sound effects', 'Rain, crowds, footsteps and whooshes, made to order.'],
      ['Stems for remixing', 'Split a song into vocals, drums, bass and the rest.'],
    ],
  },
  {
    id: 'photos',
    eyebrow: 'Pictures and photos',
    title: 'An AI image generator, and a darkroom for old photos',
    intro: 'Make new pictures from words, and give old ones a second life.',
    items: [
      ['Pictures from a line', 'Illustrations, covers and posters in your own style.'],
      ['Edit with words', 'Say what to change in a picture, and it changes.'],
      ['Restore old photos', 'Mend creases and scratches, add colour back and sharpen faces.'],
      ['Bigger, sharper and finished', 'Enlarge your pictures without losing detail, and finish them with a look of your choosing.'],
    ],
  },
  {
    id: 'more',
    eyebrow: 'And more',
    title: '3D, templates and a private library',
    intro: 'The quiet helpers that make the rest quicker.',
    items: [
      ['3D models from a picture or a line', 'Turn a sketch, a photo or a sentence into a model you can spin.'],
      ['Templates to start fast', 'Ready-made starting points for ads, posters, songs and films.'],
      ['A private library', 'Everything you make, kept together and yours alone.'],
      ['Made for teams', 'Work side by side with your colleagues in one studio.'],
    ],
  },
]

export function StudioPage() {
  usePageMeta(STUDIO_META)
  return (
    <MarketingLayout>
      <section className="page-head" aria-labelledby="studio-title">
        <p className="eyebrow">The studio</p>
        <h1 id="studio-title">What you can make with Jafat</h1>
        <p className="lede">
          AI ads for Instagram and TikTok, Urdu poetry videos, dubbing, voices, music and restored photos: one studio, in English and Urdu.
        </p>
        <nav className="jump" aria-label="On this page">
          {GROUPS.map((g) => (
            <a key={g.id} href={`#${g.id}`}>
              {g.title}
            </a>
          ))}
        </nav>
      </section>

      <section aria-labelledby="tools-title" data-reveal>
        <div className="section-head">
          <p className="eyebrow">The Studio</p>
          <h2 id="tools-title">Everything you need to create, in one place</h2>
        </div>
        <StudioTiles anchors />
      </section>

      {GROUPS.map((g, i) => (
        <section key={g.id} id={g.id} className={`group${i % 2 ? ' flip' : ''}`} aria-labelledby={`${g.id}-title`} data-reveal>
          <div className="group-head">
            <p className="eyebrow">{g.eyebrow}</p>
            <h2 id={`${g.id}-title`}>{g.title}</h2>
            <p>{g.intro}</p>
          </div>
          <div className="group-cards">
            {g.items.map(([title, text]) => (
              <article key={title} className="card sheet">
                <img className="icon" src={QUILL} alt="" />
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>
      ))}

      <section className="sheet map finale" aria-labelledby="studio-finale" data-reveal>
        <h2 id="studio-finale">Try it on your own idea</h2>
        <p>A free account opens the whole studio. Your work stays yours.</p>
        <div className="actions">
          <CreateButton />
        </div>
      </section>
    </MarketingLayout>
  )
}
