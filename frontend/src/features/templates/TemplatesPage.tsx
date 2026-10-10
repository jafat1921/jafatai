import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowRight, LayoutTemplate, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Chip } from '@/components/studio/chip'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useStartTemplate, useTemplates } from '@/hooks/useStudio'
import { splitPlaceholders } from '@/lib/images'
import { localStart, TARGET_ROUTE, type TemplatePrefill } from '@/lib/templates'
import { AUDIO_ROUTE, audioKindOf, KIND_NOUN } from '@/lib/audio'
import type { Template, TemplateStart, TemplateType } from '@/lib/types'
import { formatRuntime } from '@/lib/utils'
import { TemplatePreview } from './TemplatePreview'

function Highlighted({ text, examples }: { text: string; examples?: Record<string, string> }) {
  return (
    <>
      {splitPlaceholders(text).map((p, i) => {
        if (!p.slot) return <span key={i}>{p.text}</span>
        const ex = examples?.[p.text.slice(1, -1)]
        return (
          <mark key={i} title={ex ? `e.g. ${ex}` : undefined} className="rounded-[3px] bg-studio-gold/30 px-0.5 text-studio-text">
            {p.text}
          </mark>
        )
      })}
    </>
  )
}

function meta(t: Template) {
  const d = t.defaults ?? {}
  const bits: string[] = []
  const secs = (d.duration_s ?? d.target_runtime_s) as number | undefined
  if (typeof secs === 'number') bits.push(formatRuntime(secs))
  const aspect = (d.aspect_ratio ?? d.aspect) as string | undefined
  if (aspect) bits.push(aspect)
  if (t.type === 'video') bits.push(d.authoring_mode && d.authoring_mode !== 'quick' ? 'Studio project' : 'Quick video')
  else if (t.type === 'audio') bits.push(KIND_NOUN[audioKindOf(t)].one)
  else if (typeof d.count === 'number') bits.push(`${d.count} variations`)
  if (d.model === 'qwen_image_2512') bits.push('Qwen text')
  return bits.join(' · ')
}

const haystack = (t: Template) =>
  [t.title, t.description, t.category, ...(t.tags ?? []), String(t.defaults?.prompt_scaffold ?? '')].join(' ').toLowerCase()

function Card({ t, onStart, starting }: { t: Template; onStart: () => void; starting: boolean }) {
  const prompt = String(t.defaults?.prompt_scaffold ?? t.defaults?.logline_hint ?? '')
  return (
    <article aria-labelledby={`tpl-${t.id}`} className="flex flex-col overflow-hidden rounded-[8px] border border-studio-border-strong bg-studio-panel shadow-card">
      <TemplatePreview t={t} className="aspect-[4/3] border-x-0 border-t-0" />
      <div className="flex flex-1 flex-col gap-2 p-3">
        {t.category && <p className="section-label">{t.category}</p>}
        <h2 id={`tpl-${t.id}`} className="font-display text-panel font-semibold">
          {t.title}
        </h2>
        <p className="text-small text-studio-muted">{t.description}</p>
        {prompt && (
          <p className="line-clamp-3 rounded-[6px] border border-studio-border bg-studio-raised px-2 py-1.5 text-small">
            <Highlighted text={prompt} examples={t.examples} />
          </p>
        )}
        <p className="mt-auto font-mono text-[12px] text-studio-muted">{meta(t)}</p>
        <Button variant="primary" onClick={onStart} loading={starting} aria-label={`Use the ${t.title} prompt template`}>
          Use prompt template
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </article>
  )
}

/** Prompt template cards. Starting one only opens a prefilled form; nothing is generated until the user confirms. */
const NOUN: Record<TemplateType, string> = { video: 'Video prompt templates', image: 'Image prompt templates', audio: 'Audio prompt templates' }

// audio templates open the Song, Music or SFX page; the server's target alone can't say which
const routeFor = (t: Template, s: TemplateStart) =>
  t.type === 'audio' || s.target === 'audio' ? AUDIO_ROUTE[audioKindOf({ category: t.category, defaults: { ...t.defaults, ...(s.prefill ?? {}) } })] : (TARGET_ROUTE[s.target] ?? TARGET_ROUTE.quick)

export function TemplatesPage({ type }: { type: TemplateType }) {
  const navigate = useNavigate()
  const templates = useTemplates(type)
  const start = useStartTemplate()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string | null>(null)

  const all = templates.data
  // the server sends them in category order
  const categories = useMemo(() => [...new Set((all ?? []).map((t) => t.category).filter((c): c is string => !!c))], [all])
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (all ?? []).filter((t) => (!category || t.category === category) && words.every((w) => haystack(t).includes(w)))
  }, [all, q, category])

  const open = (t: Template) =>
    start.mutate(t.id, {
      onSettled: (res, err) => {
        // an older server without /start: the template's defaults carry the same prefill
        const s = res ?? (err ? localStart(t) : undefined)
        if (!s) return
        const template: TemplatePrefill = { templateId: t.id, templateTitle: t.title, prefill: { examples: t.examples, ...(s.prefill ?? {}) } }
        navigate(routeFor(t, s), { state: { template } })
      },
    })

  const noun = NOUN[type]
  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="tpl-title">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="tpl-title" className="flex items-center gap-2 font-display text-title font-semibold">
              <LayoutTemplate aria-hidden className="size-5 text-studio-accent" />
              {noun}
            </h1>
            <p className="text-body text-studio-muted">
              Ready-made prompts with the settings filled in. Swap the <mark className="rounded-[3px] bg-studio-gold/30 px-0.5">[highlighted]</mark> words for
              your own before you create.
            </p>
          </div>
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
            <Input type="search" placeholder="Search prompt templates" aria-label="Search prompt templates" value={q} onChange={(e) => setQ(e.target.value)} className="w-64 pl-8" />
          </div>
        </header>
        {categories.length > 1 && (
          <div role="group" aria-label="Category" className="flex flex-wrap gap-1">
            <Chip selected={category === null} onClick={() => setCategory(null)}>
              All
            </Chip>
            {categories.map((c) => (
              <Chip key={c} selected={category === c} onClick={() => setCategory(category === c ? null : c)}>
                {c}
              </Chip>
            ))}
          </div>
        )}
        {templates.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4" role="status" aria-label="Loading prompt templates">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-80" />
            ))}
          </div>
        ) : templates.isError ? (
          <ErrorState title="Couldn't load the prompt templates" error={templates.error} onRetry={() => templates.refetch()} />
        ) : templates.data.length === 0 ? (
          <EmptyState icon={<LayoutTemplate />} title="No prompt templates yet">
            Prompt templates ship with the server; this one has none for {type === 'audio' ? 'audio' : `${type}s`}.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<Search />}
            title="Nothing matches"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setQ('')
                  setCategory(null)
                }}
              >
                Show all
              </Button>
            }
          >
            No prompt template matches {q ? `"${q}"` : 'this filter'}
            {category ? ` in ${category}` : ''}.
          </EmptyState>
        ) : (
          <>
            <p className="sr-only" role="status">
              {shown.length} of {templates.data.length} prompt templates
            </p>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
              {shown.map((t) => (
                <li key={t.id} className="flex [&>article]:w-full">
                  <Card t={t} onStart={() => open(t)} starting={start.isPending && start.variables === t.id} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  )
}
