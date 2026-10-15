import { useState } from 'react'
import { Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SourceDropZone } from '@/components/media/SourceDropZone'
import { ErrorState } from '@/components/studio/states'
import { useAdStyle } from '@/hooks/useBrandKits'
import { styleLabel } from '@/lib/ads'
import { addRefs, MAX_AD_REFS, type AdStyleRules, type BrandKit } from '@/lib/brand'
import { EditorSection } from './EditorSection'

const WORDS: Record<string, string> = {
  sentence: 'sentence case',
  upper: 'capitals',
  uppercase: 'capitals',
  title: 'title case',
  lower: 'lower case',
  dots: 'dots',
  blob: 'blobs',
  blobs: 'blobs',
}
const word = (v: string) => WORDS[v] ?? v.replace(/_/g, ' ')
const yesNo = (v: boolean | undefined) => (v === undefined ? null : v ? 'Yes' : 'No')

function rulesList(r: AdStyleRules): [string, string][] {
  const rows: [string, string | null][] = [
    ['Layouts', r.layouts?.length ? r.layouts.map(styleLabel).join(', ') + (r.pinned ? ' (only these)' : '') : null],
    ['Shapes', [...(r.shapes ?? []).map(word), ...(r.mask ? [`${r.mask} photo mask`] : [])].join(', ') || null],
    ['Headline', [r.headline_weight, r.headline_case && word(r.headline_case)].filter(Boolean).join(', ') || null],
    ['Serif type', yesNo(r.serif)],
    ['Colour use', r.colour_usage ? word(r.colour_usage) : null],
    ['Background', r.background ? word(r.background) : null],
    ['Density', r.density ? word(r.density) : null],
    ['Badge', yesNo(r.badge)],
    ['Notes', r.notes?.trim() || null],
  ]
  return rows.filter((x): x is [string, string] => !!x[1])
}

/** The owner's own adverts, read once into layout rules that Ad Studio then follows. */
export function AdStyleSection({ kit: initial }: { kit: BrandKit }) {
  const { kit, put, extract } = useAdStyle(initial)
  const [notice, setNotice] = useState<string | null>(null)
  const style = kit.ad_style
  const refs = style?.references ?? []
  const ids = refs.map((r) => r.media_id)
  const status = style?.status ?? 'none'
  const working = status === 'working' || put.isPending || extract.isPending
  const rules = status === 'ready' && style?.rules ? rulesList(style.rules) : []

  const save = (next: string[]) => put.mutate(next)

  return (
    <EditorSection
      title={`Ad style references (${refs.length}/${MAX_AD_REFS})`}
      hint="Add up to six of your own adverts. Ad Studio reads their layouts, shapes and type and follows them in new campaigns. Saved straight away."
    >
      {refs.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Ad style references">
          {refs.map((r, i) => (
            <li key={r.media_id} className="relative">
              <figure className="aspect-[4/5] overflow-hidden rounded-[6px] border border-studio-border bg-studio-raised">
                {r.media_url ? <img src={r.media_url} alt={`Your ad ${i + 1}`} className="size-full object-cover" /> : null}
              </figure>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="absolute right-1 top-1"
                aria-label={`Remove ad ${i + 1}`}
                disabled={put.isPending}
                onClick={() => {
                  save(ids.filter((x) => x !== r.media_id))
                  setNotice(null)
                }}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {refs.length < MAX_AD_REFS && (
        <SourceDropZone
          label="Add your ads"
          purpose="reference"
          multiple
          pickMax={MAX_AD_REFS - refs.length}
          taken={ids}
          onAdd={(items) => {
            const next = addRefs(ids, items.map((m) => m.id), MAX_AD_REFS)
            if (next.ids.length !== ids.length) save(next.ids)
            setNotice(next.dropped ? `A kit keeps ${MAX_AD_REFS} ads, so ${next.dropped} weren't added.` : null)
          }}
        />
      )}
      {notice && (
        <p role="status" className="text-small text-studio-warning">
          {notice}
        </p>
      )}
      {put.isError && <ErrorState compact title="Couldn't save the ads" error={put.error} />}

      <div aria-live="polite" className="flex flex-col gap-2">
        {working && refs.length > 0 && (
          <p className="flex items-center gap-2 text-small text-studio-muted">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Reading your ads…
          </p>
        )}
        {!working && status === 'failed' && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-danger/40 bg-studio-danger/5 p-2.5 text-small">
            <span>Couldn't read your ads{style?.error ? `: ${style.error}` : '.'}</span>
            <Button type="button" size="sm" variant="secondary" className="ml-auto" disabled={!refs.length} onClick={() => extract.mutate()}>
              <RefreshCw aria-hidden />
              Try again
            </Button>
          </div>
        )}
        {extract.isError && <ErrorState compact title="Couldn't start reading the ads" error={extract.error} />}
        {!working && rules.length > 0 && (
          <div className="rounded-[6px] border border-studio-border bg-studio-raised p-3">
            <h3 className="mb-1.5 text-small font-medium">What Ad Studio follows</h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-small">
              {rules.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-studio-muted">{k}</dt>
                  <dd dir="auto">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </EditorSection>
  )
}
