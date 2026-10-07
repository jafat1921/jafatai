import { useNavigate } from 'react-router'
import { ArrowRight, Clapperboard, ImageIcon, LayoutTemplate } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useStartTemplate, useTemplates } from '@/hooks/useStudio'
import { splitPlaceholders } from '@/lib/images'
import { localStart, TARGET_ROUTE, type TemplatePrefill } from '@/lib/templates'
import type { Template } from '@/lib/types'
import { formatRuntime } from '@/lib/utils'

function Highlighted({ text }: { text: string }) {
  return (
    <>
      {splitPlaceholders(text).map((p, i) =>
        p.slot ? (
          <mark key={i} className="rounded-[3px] bg-studio-gold/30 px-0.5 text-studio-text">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
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
  else if (typeof d.count === 'number') bits.push(`${d.count} variations`)
  return bits.join(' · ')
}

function Card({ t, onStart, starting }: { t: Template; onStart: () => void; starting: boolean }) {
  const prompt = String(t.defaults?.prompt_scaffold ?? t.defaults?.logline_hint ?? '')
  return (
    <article aria-labelledby={`tpl-${t.id}`} className="flex flex-col overflow-hidden rounded-[8px] border border-studio-border-strong bg-studio-panel shadow-card">
      <div className="darkroom flex aspect-video items-center justify-center border-x-0 border-t-0">
        {t.thumb ? (
          <img src={t.thumb} alt="" className="size-full object-cover" loading="lazy" />
        ) : t.type === 'video' ? (
          <Clapperboard aria-hidden className="size-7 text-studio-on-dark-muted" />
        ) : (
          <ImageIcon aria-hidden className="size-7 text-studio-on-dark-muted" />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <h2 id={`tpl-${t.id}`} className="font-display text-panel font-semibold">
          {t.title}
        </h2>
        <p className="text-small text-studio-muted">{t.description}</p>
        {prompt && (
          <p className="line-clamp-3 rounded-[6px] border border-studio-border bg-studio-raised px-2 py-1.5 text-small">
            <Highlighted text={prompt} />
          </p>
        )}
        <p className="mt-auto font-mono text-[12px] text-studio-muted">{meta(t)}</p>
        <Button variant="primary" onClick={onStart} loading={starting} aria-label={`Use the ${t.title} template`}>
          Use template
          <ArrowRight aria-hidden />
        </Button>
      </div>
    </article>
  )
}

/** Template cards. Starting one only opens a prefilled form; nothing is generated until the user confirms. */
export function TemplatesPage({ type }: { type: 'video' | 'image' }) {
  const navigate = useNavigate()
  const templates = useTemplates(type)
  const start = useStartTemplate()

  const open = (t: Template) =>
    start.mutate(t.id, {
      onSettled: (res, err) => {
        // an older server without /start: the template's defaults carry the same prefill
        const s = res ?? (err ? localStart(t) : undefined)
        if (!s) return
        const template: TemplatePrefill = { templateId: t.id, templateTitle: t.title, prefill: s.prefill ?? {} }
        navigate(TARGET_ROUTE[s.target] ?? TARGET_ROUTE.quick, { state: { template } })
      },
    })

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-labelledby="tpl-title">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 md:px-8">
        <header>
          <h1 id="tpl-title" className="flex items-center gap-2 font-display text-title font-semibold">
            <LayoutTemplate aria-hidden className="size-5 text-studio-accent" />
            {type === 'video' ? 'Video templates' : 'Image templates'}
          </h1>
          <p className="text-body text-studio-muted">
            Starting points with the settings filled in. Swap the <mark className="rounded-[3px] bg-studio-gold/30 px-0.5">[highlighted]</mark> words for your own
            before you create.
          </p>
        </header>
        {templates.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4" role="status" aria-label="Loading templates">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-80" />
            ))}
          </div>
        ) : templates.isError ? (
          <ErrorState title="Couldn't load the templates" error={templates.error} onRetry={() => templates.refetch()} />
        ) : templates.data.length === 0 ? (
          <EmptyState icon={<LayoutTemplate />} title="No templates yet">
            Templates ship with the server; this one has none for {type}s.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {templates.data.map((t) => (
              <li key={t.id} className="flex [&>article]:w-full">
                <Card t={t} onStart={() => open(t)} starting={start.isPending && start.variables === t.id} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
