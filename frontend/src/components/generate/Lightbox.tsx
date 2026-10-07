import { useState } from 'react'
import { Link } from 'react-router'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Brush, ChevronLeft, ChevronRight, Clapperboard, Copy, Download, ExternalLink, Heart, ImageUpscale, Layers, PanelRightOpen, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useBrandKits } from '@/hooks/useBrandKits'
import { downloadUrl } from '@/lib/media'
import { cn, timeAgo } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { useModelLabels } from './useModelLabel'

/** Anything the lightbox can show: a library item, a project render, a generation. */
export interface LightboxEntry {
  key: string
  kind: 'image' | 'video'
  src: string | null
  poster?: string | null
  title: string
  prompt?: string | null
  modelId?: string | null
  seed?: number | null
  size?: string | null
  brandKitId?: string | null
  createdAt: string
  projectId?: string | null
  generationId: string
  favourite?: boolean
}

export interface LightboxActions {
  favourite?: (e: LightboxEntry) => void
  upscale?: (e: LightboxEntry) => void
  edit?: (e: LightboxEntry) => void
  animate?: (e: LightboxEntry) => void
  onUseAsRef?: (e: LightboxEntry) => void
  reuse?: (e: LightboxEntry) => void
  details?: (e: LightboxEntry) => void
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-2 text-small">
      <dt className="text-studio-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

interface Props {
  entries: LightboxEntry[]
  index: number | null
  onIndex: (i: number) => void
  onClose: () => void
  actions: LightboxActions
  refLabel?: string
  detailsLabel?: string
}

/** Darkroom media on the left, the parchment record on the right. ←/→, Esc, F, U, E, A. */
export function Lightbox(props: Props) {
  const entry = props.index != null ? props.entries[props.index] : undefined
  // mounted only while open, so a closed lightbox costs no requests
  return entry ? <LightboxView {...props} entry={entry} index={props.index!} /> : null
}

function LightboxView({ entries, entry, index, onIndex, onClose, actions, refLabel = 'Use as reference', detailsLabel = 'Versions & details' }: Props & { entry: LightboxEntry; index: number }) {
  const open = true
  const label = useModelLabels()
  const { kits } = useBrandKits()
  // which entry the "Copied" belongs to, so browsing on resets it
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copied = copiedKey === entry.key

  const go = (d: number) => {
    if (entries.length < 2) return
    onIndex((index + d + entries.length) % entries.length)
  }
  const image = entry.kind === 'image'
  const run = (fn: ((e: LightboxEntry) => void) | undefined) => fn && (() => fn(entry))
  const brand = entry.brandKitId ? (kits.find((k) => k.id === entry.brandKitId)?.name ?? 'A brand kit') : null

  const onKey = (e: React.KeyboardEvent) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
    const k = e.key.toLowerCase()
    const map: Record<string, (() => void) | undefined> = {
      arrowleft: () => go(-1),
      arrowright: () => go(1),
      f: run(actions.favourite),
      u: run(actions.upscale),
      e: image ? run(actions.edit) : undefined,
      a: image ? run(actions.animate) : undefined,
    }
    const fn = map[k]
    if (fn) {
      e.preventDefault()
      fn()
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.prompt ?? '')
      setCopiedKey(entry.key)
      announce('Prompt copied.')
    } catch {
      announce("Couldn't copy. Select the prompt text instead.")
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgb(28_20_12/0.85)] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={onKey}
          className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-studio-darkroom focus-visible:outline-none md:inset-4 md:flex-row md:overflow-hidden md:rounded-[8px] md:border md:border-studio-gold/60 md:shadow-modal"
        >
          <div className="relative flex min-h-[50vh] flex-1 items-center justify-center p-3 md:min-h-0 md:p-6">
            {entry.src ? (
              image ? (
                <img key={entry.key} src={entry.src} alt={entry.title} className="max-h-full max-w-full object-contain motion-safe:animate-fade-in" />
              ) : (
                <video key={entry.key} src={entry.src} poster={entry.poster ?? undefined} controls playsInline aria-label={entry.title} className="max-h-full max-w-full" />
              )
            ) : (
              <p className="text-body text-studio-on-dark-muted">Not ready yet.</p>
            )}
            {entries.length > 1 && (
              <>
                <button type="button" onClick={() => go(-1)} aria-label="Previous" className="absolute left-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-studio-darkroom/70 text-studio-on-dark ring-1 ring-studio-gold/40 hover:bg-studio-darkroom">
                  <ChevronLeft aria-hidden className="size-5" />
                </button>
                <button type="button" onClick={() => go(1)} aria-label="Next" className="absolute right-2 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-studio-darkroom/70 text-studio-on-dark ring-1 ring-studio-gold/40 hover:bg-studio-darkroom">
                  <ChevronRight aria-hidden className="size-5" />
                </button>
              </>
            )}
          </div>

          <aside className="paper-fine flex w-full shrink-0 flex-col gap-3 bg-studio-raised p-4 text-studio-text md:w-[360px] md:overflow-y-auto">
            <div className="flex items-start gap-2">
              <DialogPrimitive.Title className="min-w-0 flex-1 font-display text-panel font-semibold">{entry.title}</DialogPrimitive.Title>
              <DialogPrimitive.Close className="rounded-[6px] p-1.5 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text" aria-label="Close">
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
            {entries.length > 1 && (
              <p className="-mt-2 font-mono text-[11px] text-studio-muted">
                {index + 1} of {entries.length}
              </p>
            )}

            <dl className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-panel p-3">
              <Meta label="Prompt">
                <span dir="auto">{entry.prompt || <span className="text-studio-muted">—</span>}</span>
              </Meta>
              <Meta label="Model">{label(entry.modelId) ?? <span className="text-studio-muted">Not recorded</span>}</Meta>
              <Meta label="Seed">
                <span className="font-mono">{entry.seed ?? '—'}</span>
              </Meta>
              <Meta label="Size">
                <span className="font-mono">{entry.size ?? '—'}</span>
              </Meta>
              <Meta label="Brand">{brand ?? 'None'}</Meta>
              <Meta label="Created">{timeAgo(entry.createdAt)}</Meta>
            </dl>

            <div className="flex flex-wrap gap-2">
              {entry.prompt && (
                <Button type="button" size="sm" variant="secondary" onClick={copy}>
                  <Copy aria-hidden />
                  {copied ? 'Copied' : 'Copy prompt'}
                </Button>
              )}
              {actions.reuse && (
                <Button type="button" size="sm" variant="secondary" onClick={run(actions.reuse)}>
                  <RotateCcw aria-hidden />
                  Reuse all settings
                </Button>
              )}
              {image && actions.onUseAsRef && (
                <Button type="button" size="sm" variant="secondary" onClick={run(actions.onUseAsRef)}>
                  <Layers aria-hidden />
                  {refLabel}
                </Button>
              )}
              {entry.projectId && (
                <Button asChild size="sm" variant="secondary">
                  <Link to={`/projects/${entry.projectId}/output`}>
                    <ExternalLink aria-hidden />
                    Open in Studio
                  </Link>
                </Button>
              )}
            </div>

            <div className="flex flex-wrap gap-1 border-t border-studio-border pt-3">
              {actions.favourite && (
                <Button type="button" size="sm" variant="ghost" aria-pressed={!!entry.favourite} onClick={run(actions.favourite)}>
                  <Heart aria-hidden className={cn(entry.favourite && 'fill-current text-studio-accent')} />
                  Favourite <Kbd>F</Kbd>
                </Button>
              )}
              {actions.upscale && entry.src && (
                <Button type="button" size="sm" variant="ghost" onClick={run(actions.upscale)}>
                  <ImageUpscale aria-hidden />
                  Upscale <Kbd>U</Kbd>
                </Button>
              )}
              {image && actions.edit && (
                <Button type="button" size="sm" variant="ghost" onClick={run(actions.edit)}>
                  <Brush aria-hidden />
                  Edit <Kbd>E</Kbd>
                </Button>
              )}
              {image && actions.animate && (
                <Button type="button" size="sm" variant="ghost" onClick={run(actions.animate)}>
                  <Clapperboard aria-hidden />
                  Animate <Kbd>A</Kbd>
                </Button>
              )}
              {entry.src && (
                <Button asChild size="sm" variant="ghost">
                  <a href={downloadUrl(entry.generationId)} download>
                    <Download aria-hidden />
                    Download
                  </a>
                </Button>
              )}
              {actions.details && (
                <Button type="button" size="sm" variant="ghost" onClick={run(actions.details)}>
                  <PanelRightOpen aria-hidden />
                  {detailsLabel}
                </Button>
              )}
            </div>
            <p className="mt-auto text-small text-studio-muted max-md:hidden">
              <Kbd>←</Kbd> <Kbd>→</Kbd> browse · <Kbd>Esc</Kbd> close
            </p>
          </aside>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
