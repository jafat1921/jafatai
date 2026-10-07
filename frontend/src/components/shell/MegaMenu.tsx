import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { Badge, Feature, MenuSection, Model } from '@/lib/nav'
import { cn } from '@/lib/utils'

const BADGE_TONE: Record<Badge, string> = {
  FAST: 'border-studio-success/60 text-studio-success',
  BEST: 'border-studio-accent/60 bg-studio-accent-soft text-studio-accent-hover',
  UPSCALE: 'border-studio-border-strong text-studio-muted',
  QUICK: 'border-studio-warning/50 text-studio-warning',
  NEW: 'border-studio-gold bg-studio-gold/15 text-studio-accent-hover',
  TEXT: 'border-studio-border-strong bg-studio-raised text-studio-text',
  HQ: 'border-studio-accent/60 bg-studio-accent-soft text-studio-accent-hover',
}

export function ModelBadge({ badge }: { badge: Badge }) {
  return (
    <span className={cn('rounded-[4px] border px-1.5 font-mono text-[11px] font-medium leading-[18px] tracking-wide', BADGE_TONE[badge])}>
      {badge}
    </span>
  )
}

const ITEM = 'flex items-start gap-3 rounded-[6px] p-2 text-left transition-colors duration-150 hover:bg-studio-panel-hover focus-visible:bg-studio-panel-hover'

export function FeatureLink({ f, onPick, col }: { f: Feature; onPick: () => void; col?: number }) {
  const body = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[6px] border border-studio-gold/60 bg-studio-raised text-studio-accent shadow-card">
        <f.icon aria-hidden className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-body font-medium text-studio-text">{f.title}</span>
        <span className="block text-small text-studio-muted">{f.description}</span>
      </span>
    </>
  )
  if (f.disabled) {
    return (
      <span aria-disabled="true" data-mm-col={col} tabIndex={-1} className={cn(ITEM, 'opacity-60 hover:bg-transparent')}>
        {body}
      </span>
    )
  }
  return (
    <Link to={f.to} onClick={onPick} data-mm-col={col} className={ITEM}>
      {body}
    </Link>
  )
}

export function ModelLink({ m, onPick, col }: { m: Model; onPick: () => void; col?: number }) {
  return (
    <Link to={m.to} onClick={onPick} data-mm-col={col} className={ITEM} aria-label={`${m.name}${m.badge ? `, ${m.badge}` : ''}: ${m.description}`}>
      <span aria-hidden className="darkroom flex size-9 shrink-0 items-center justify-center rounded-[6px] font-display text-panel font-bold">
        {m.mark}
      </span>
      <span className="min-w-0 flex-1" aria-hidden>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-body font-medium text-studio-text">{m.name}</span>
          {m.badge && <ModelBadge badge={m.badge} />}
        </span>
        <span className="block text-small text-studio-muted">{m.description}</span>
      </span>
    </Link>
  )
}

interface Props {
  id: string
  section: MenuSection
  anchorId: string
  keyboard: boolean
  onPick: () => void
  onClose: (returnFocus: boolean) => void
  onPointerEnter: () => void
  onPointerLeave: (e: React.PointerEvent) => void
}

const focusables = (root: HTMLElement, col: number) => Array.from(root.querySelectorAll<HTMLElement>(`a[data-mm-col="${col}"]`))

export function MegaMenu({ id, section, anchorId, keyboard, onPick, onClose, onPointerEnter, onPointerLeave }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(8)
  const cols = section.models.length ? 2 : 1

  // sit level with the rail item, but never run off the bottom of the window
  useLayoutEffect(() => {
    const rect = document.getElementById(anchorId)?.getBoundingClientRect()
    const h = ref.current?.offsetHeight ?? 0
    setTop(Math.max(8, Math.min((rect?.top ?? 8) - 12, window.innerHeight - h - 8)))
  }, [anchorId, section])

  useEffect(() => {
    if (keyboard && ref.current) focusables(ref.current, 0)[0]?.focus()
  }, [keyboard])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const root = ref.current
    if (!root) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return onClose(true)
    }
    const active = document.activeElement as HTMLElement | null
    const col = Number(active?.dataset.mmCol ?? 0)
    const items = focusables(root, col)
    const i = items.indexOf(active!)
    const go = (el: HTMLElement | undefined) => {
      if (!el) return
      e.preventDefault()
      el.focus()
    }
    switch (e.key) {
      case 'ArrowDown':
        return go(items[(i + 1) % items.length])
      case 'ArrowUp':
        return go(items[(i - 1 + items.length) % items.length])
      case 'Home':
        return go(items[0])
      case 'End':
        return go(items[items.length - 1])
      case 'ArrowRight':
      case 'ArrowLeft': {
        if (cols < 2) return
        const other = focusables(root, col === 0 ? 1 : 0)
        return go(other[Math.min(Math.max(i, 0), other.length - 1)])
      }
      case 'Tab': {
        // Tab moves between the two columns and stays inside the panel while it's open
        // (opened by hover, Tab just carries on through the page)
        if (!keyboard) return
        if (cols < 2) return go(items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length])
        return go(focusables(root, col === 0 ? 1 : 0)[0])
      }
    }
  }

  return (
    <div
      ref={ref}
      id={id}
      role="group"
      aria-label={section.title}
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ top }}
      className={cn(
        'fixed left-[80px] z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-[8px] border border-studio-gold/70 bg-studio-raised p-4 shadow-modal paper-fine motion-safe:animate-fade-in',
        cols === 2 ? 'w-[min(680px,calc(100vw-96px))]' : 'w-[min(380px,calc(100vw-96px))]',
      )}
    >
      <h2 className="mb-3 border-b border-studio-gold/40 pb-2 font-display text-title font-semibold">{section.title}</h2>
      <div className={cn('grid gap-4', cols === 2 && 'grid-cols-2')}>
        <section aria-label="Features">
          <h3 className="section-label mb-1 px-2" aria-hidden>
            Features
          </h3>
          <ul className="flex flex-col">
            {section.features.map((f) => (
              <li key={f.id}>
                <FeatureLink f={f} col={0} onPick={onPick} />
              </li>
            ))}
          </ul>
        </section>
        {cols === 2 && (
          <section aria-label="Models" className="border-l border-studio-border pl-4">
            <h3 className="section-label mb-1 px-2" aria-hidden>
              Models
            </h3>
            <ul className="flex flex-col">
              {section.models.map((m) => (
                <li key={m.id}>
                  <ModelLink m={m} col={1} onPick={onPick} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {section.modelsNote && <p className="mt-3 border-t border-studio-border px-2 pt-2 text-small text-studio-muted">{section.modelsNote}</p>}
    </div>
  )
}
