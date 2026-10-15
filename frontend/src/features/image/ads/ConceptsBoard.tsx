import { useId, useState } from 'react'
import { RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { usePatchConcept, useRegenerateConcept } from '@/hooks/useAds'
import { STYLES, type AdCampaign, type AdConcept, type AdStyle, type ConceptPatch } from '@/lib/ads'
import { announce } from '@/stores/ui'

const SELECT = 'h-8 w-full rounded-[6px] border border-studio-border-strong bg-studio-raised px-2 text-body focus-visible:outline-2 focus-visible:outline-studio-accent'
const FIELDS = ['kicker', 'headline', 'body', 'cta', 'layout', 'photo_prompt'] as const
type Draft = Pick<AdConcept, (typeof FIELDS)[number]>

const draftOf = (c: AdConcept): Draft => ({ kicker: c.kicker, headline: c.headline, body: c.body, cta: c.cta, layout: c.layout, photo_prompt: c.photo_prompt })

function ConceptCard({ camp, concept, busy }: { camp: AdCampaign; concept: AdConcept; busy: boolean }) {
  const uid = useId()
  const id = (s: string) => `${uid}-${s}`
  const patch = usePatchConcept(camp.id)
  const regen = useRegenerateConcept(camp.id)
  const [d, setD] = useState<Draft>(() => draftOf(concept))
  const server = JSON.stringify(draftOf(concept))
  const [seen, setSeen] = useState(server)
  // new copy from the server (a rewrite, a save) replaces the draft; another card's save leaves it alone
  if (seen !== server) {
    setSeen(server)
    setD(draftOf(concept))
  }
  const dirty = FIELDS.some((k) => d[k] !== concept[k])
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((o) => ({ ...o, [k]: v }))
  const lang = camp.language
  const dropped = [...(concept.guard.offers_dropped ?? []), ...(concept.guard.numbers_removed ?? [])]

  const save = () => {
    const body: ConceptPatch = {}
    for (const k of FIELDS) if (d[k] !== concept[k]) (body as Record<string, unknown>)[k] = d[k]
    patch.mutate({ conceptId: concept.id, ...body }, { onSuccess: () => announce(`Concept ${concept.n} saved.`) })
  }

  return (
    <li aria-labelledby={id('h')} className="flex flex-col gap-2 rounded-[8px] border border-studio-border-strong bg-studio-panel p-3 shadow-card">
      <div className="flex items-center gap-2">
        <h3 id={id('h')} className="font-display text-panel font-semibold">
          Concept {concept.n}
        </h3>
        <label className="ml-auto flex items-center gap-2 text-small">
          <Switch
            checked={concept.approved}
            disabled={busy || patch.isPending}
            onCheckedChange={(v) => patch.mutate({ conceptId: concept.id, approved: v })}
            aria-label={`Make concept ${concept.n}`}
          />
          Make this one
        </label>
      </div>
      {concept.insight && (
        <p dir="auto" lang={lang} className="text-small italic text-studio-muted">
          {concept.insight}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={id('kicker')} className="text-small font-medium">
          Kicker
        </label>
        <Input id={id('kicker')} dir="auto" lang={lang} maxLength={300} value={d.kicker} onChange={(e) => set('kicker', e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id('headline')} className="text-small font-medium">
          Headline
        </label>
        <Textarea id={id('headline')} dir="auto" lang={lang} rows={2} maxLength={300} value={d.headline} onChange={(e) => set('headline', e.target.value)} className="font-display text-[18px] font-semibold" aria-describedby={id('hl-hint')} />
        <span id={id('hl-hint')} className="text-small text-studio-muted">
          A new line here is a line break in the ad.
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id('body')} className="text-small font-medium">
          Body
        </label>
        <Textarea id={id('body')} dir="auto" lang={lang} rows={2} maxLength={600} value={d.body} onChange={(e) => set('body', e.target.value)} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={id('cta')} className="text-small font-medium">
            Button
          </label>
          <Input id={id('cta')} dir="auto" lang={lang} maxLength={60} value={d.cta} onChange={(e) => set('cta', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={id('layout')} className="text-small font-medium">
            Layout
          </label>
          <select id={id('layout')} className={SELECT} value={d.layout} onChange={(e) => set('layout', e.target.value as AdStyle)}>
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {concept.offers.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-small font-medium">Offers used</span>
          <ul className="flex flex-wrap gap-1.5">
            {concept.offers.map((o) => (
              <li key={o} dir="auto" className="rounded-full border border-studio-border-strong bg-studio-raised px-2.5 py-0.5 text-small">
                {o}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dropped.length > 0 && (
        <p className="text-small text-studio-muted" role="note">
          Left out because they weren't in your offers: <span dir="auto">{dropped.join(' · ')}</span>
        </p>
      )}
      <details className="text-small">
        <summary className="cursor-pointer text-studio-muted">Photo idea</summary>
        <label htmlFor={id('photo')} className="sr-only">
          Photo prompt
        </label>
        <Textarea id={id('photo')} rows={3} maxLength={2000} value={d.photo_prompt} onChange={(e) => set('photo_prompt', e.target.value)} className="mt-1" />
      </details>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="primary" disabled={!dirty || busy || !d.headline.trim()} loading={patch.isPending} onClick={save}>
          <Save aria-hidden />
          Save changes
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          loading={regen.isPending}
          onClick={() => regen.mutate({ conceptId: concept.id, what: 'copy' }, { onSuccess: () => announce(`Writing concept ${concept.n} again.`) })}
        >
          <RefreshCw aria-hidden />
          New copy
        </Button>
      </div>
      {(patch.isError || regen.isError) && (
        <p role="alert" className="text-small text-studio-danger">
          {(patch.error ?? regen.error)?.message}
        </p>
      )}
    </li>
  )
}

/** The concepts for approval: edit any line, untick the ones not to make. */
export function ConceptsBoard({ camp, busy }: { camp: AdCampaign; busy: boolean }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="Concepts">
      {camp.concepts.map((c) => (
        <ConceptCard key={c.id} camp={camp} concept={c} busy={busy} />
      ))}
    </ul>
  )
}
