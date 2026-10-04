import * as React from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { PANEL_LIMITS, useWorkspace, type PanelId } from '@/stores/workspace'
import { cn } from '@/lib/utils'

interface Props {
  id: PanelId
  as?: 'aside' | 'nav' | 'section'
  icon: React.ComponentType<{ className?: string }>
  actions?: React.ReactNode
  children: React.ReactNode
}

const STEP = 16

export function ResizablePanel({ id, as: Tag = 'aside', icon: Icon, actions, children }: Props) {
  const { width, collapsed } = useWorkspace((s) => s.panels[id])
  const setWidth = useWorkspace((s) => s.setWidth)
  const toggle = useWorkspace((s) => s.toggleCollapsed)
  const limits = PANEL_LIMITS[id]
  const label = limits.label
  const drag = React.useRef<{ x: number; w: number } | null>(null)

  if (collapsed) {
    return (
      <Tag
        aria-label={label}
        data-f6-region
        tabIndex={-1}
        className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-studio-border bg-studio-panel py-2 focus-visible:outline-none"
      >
        <Tooltip content={`Show ${label}`} side="right">
          <Button size="icon-sm" variant="ghost" aria-label={`Show ${label}`} aria-expanded={false} onClick={() => toggle(id, false)}>
            <PanelLeftOpen aria-hidden />
          </Button>
        </Tooltip>
        <Icon aria-hidden className="size-4 text-studio-muted" />
        <span className="section-label [writing-mode:vertical-rl]" aria-hidden>
          {label}
        </span>
      </Tag>
    )
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: width }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) setWidth(id, drag.current.w + e.clientX - drag.current.x)
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const next =
      e.key === 'ArrowLeft' ? width - STEP
      : e.key === 'ArrowRight' ? width + STEP
      : e.key === 'Home' ? limits.min
      : e.key === 'End' ? limits.max
      : null
    if (next === null) return
    e.preventDefault()
    setWidth(id, next)
  }

  return (
    <Tag
      aria-label={label}
      data-f6-region
      tabIndex={-1}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-studio-border bg-studio-panel focus-visible:outline-none"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-studio-border pl-3 pr-1.5">
        <h2 className="flex-1 truncate font-display text-panel font-semibold">{label}</h2>
        {actions}
        <Tooltip content={`Hide ${label}`}>
          <Button size="icon-sm" variant="ghost" aria-label={`Hide ${label}`} aria-expanded onClick={() => toggle(id, true)}>
            <PanelLeftClose aria-hidden />
          </Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1">{children}</div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label}`}
        aria-valuenow={width}
        aria-valuemin={limits.min}
        aria-valuemax={limits.max}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setWidth(id, limits.default)}
        className={cn(
          'absolute -right-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize touch-none',
          'after:absolute after:inset-y-0 after:left-[2px] after:w-[2px] after:bg-transparent after:transition-colors hover:after:bg-studio-accent focus-visible:after:bg-studio-accent-hover focus-visible:outline-none',
        )}
      />
    </Tag>
  )
}
