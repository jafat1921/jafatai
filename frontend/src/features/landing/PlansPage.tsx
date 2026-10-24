import { MarketingLayout } from './MarketingLayout'
import { usePageMeta } from './head'
import { PricingCards } from './parts'
import { PLANS_FAQ, PLANS_META } from './meta'

export function PlansPage() {
  usePageMeta(PLANS_META)
  return (
    <MarketingLayout>
      <section className="page-head" aria-labelledby="plans-title">
        <p className="eyebrow">Plans</p>
        <h1 id="plans-title">Simple, fair pricing</h1>
        <p className="lede">Start free with the whole studio, and move up when you need more room.</p>
      </section>

      <section className="sheet price-band" aria-label="Plans" data-reveal data-live>
        <PricingCards />
      </section>

      <p className="plans-note">Prices in Pakistani rupees, with local payment methods. Ask us about plans for teams and studios.</p>

      <section className="faq" aria-labelledby="faq-title" data-reveal>
        <div className="section-head">
          <p className="eyebrow">Questions</p>
          <h2 id="faq-title">Asked at the door</h2>
        </div>
        {PLANS_FAQ.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </section>
    </MarketingLayout>
  )
}
