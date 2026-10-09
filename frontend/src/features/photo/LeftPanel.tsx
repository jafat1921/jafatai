import { useState, type MouseEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Plus } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/studio/section'
import { ErrorState } from '@/components/studio/states'
import { api } from '@/lib/api'
import { compact } from '@/lib/photo/params'
import type { DevelopParams, Snapshot } from '@/lib/photo/types'
import { stepLabel } from '@/lib/photo/workflow'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { ratioZoom } from '@/lib/photo/view'
import type { CanvasView, Zoom } from './DarkroomCanvas'

// ---------------------------------------------------------------- navigator

const RATIOS: { id: string; label: string; scale: number }[] = [
  { id: '1:4', label: '1:4', scale: 0.25 }, { id: '1:3', label: '1:3', scale: 1 / 3 }, { id: '1:2', label: '1:2', scale: 0.5 },
  { id: '1:1', label: '1:1', scale: 1 }, { id: '2:1', label: '2:1', scale: 2 }, { id: '3:1', label: '3:1', scale: 3 },
  { id: '4:1', label: '4:1', scale: 4 }, { id: '8:1', label: '8:1', scale: 8 },
]


export function Navigator({ thumb, view, zoom, onZoom, onPan }: {
  thumb: string | null
  view: CanvasView | null
  zoom: Zoom
  onZoom: (z: Zoom) => void
  onPan: (p: { x: number; y: number }) => void
}) {
  const zoomed = zoom !== 'fit' && view
  const w = view ? view.frame.width * view.scale : 1
  const h = view ? view.frame.height * view.scale : 1
  // the part of the picture on screen, as fractions of the picture
  const rect = zoomed
    ? {
        left: Math.max(0, 0.5 - (view.box.w / 2 + view.off.x) / w),
        top: Math.max(0, 0.5 - (view.box.h / 2 + view.off.y) / h),
        width: Math.min(1, view.box.w / w),
        height: Math.min(1, view.box.h / h),
      }
    : null
  const jump = (e: MouseEvent<HTMLDivElement>) => {
    if (!view) return
    const r = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width
    const fy = (e.clientY - r.top) / r.height
    if (zoom === 'fit') onZoom(ratioZoom(1))
    onPan({ x: (0.5 - fx) * w, y: (0.5 - fy) * h })
  }
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const current = typeof zoom === 'number' ? RATIOS.find((r) => Math.abs(r.scale / dpr - zoom) < 1e-3)?.id ?? 'custom' : zoom
  return (
    <div className="flex flex-col gap-1.5">
      <div className="darkroom relative grid aspect-[3/2] cursor-crosshair place-items-center overflow-hidden rounded-[6px]" onClick={jump} title="Click to look closely at that spot">
        {thumb ? <img src={thumb} alt="" className="max-h-full max-w-full object-contain" draggable={false} /> : null}
        {rect && (
          <span
            aria-hidden
            className="pointer-events-none absolute border-2 border-studio-gold shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
            style={{ left: `${rect.left * 100}%`, top: `${rect.top * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
          />
        )}
      </div>
      <div role="group" aria-label="Zoom" className="flex items-center gap-1 text-[12px]">
        {(['fit', 'fill'] as const).map((z) => (
          <button key={z} type="button" aria-pressed={zoom === z} onClick={() => onZoom(z)} className={cn('rounded-[4px] px-1.5 py-0.5 capitalize', zoom === z ? 'bg-studio-accent text-studio-accent-fg' : 'hover:bg-studio-panel-hover')}>
            {z}
          </button>
        ))}
        {(['1:1', '2:1'] as const).map((id) => (
          <button key={id} type="button" aria-pressed={current === id} onClick={() => onZoom(ratioZoom(RATIOS.find((r) => r.id === id)!.scale))} className={cn('rounded-[4px] px-1.5 py-0.5', current === id ? 'bg-studio-accent text-studio-accent-fg' : 'hover:bg-studio-panel-hover')}>
            {id}
          </button>
        ))}
        <label className="ml-auto">
          <span className="sr-only">Zoom ratio</span>
          <select value={RATIOS.some((r) => r.id === current) ? current : ''} onChange={(e) => onZoom(ratioZoom(RATIOS.find((r) => r.id === e.target.value)!.scale))} className="h-6 rounded-[4px] border border-studio-border-strong bg-studio-raised px-1">
            <option value="" disabled>{typeof zoom === 'number' ? `${Math.round(zoom * dpr * 100)}%` : 'Ratio'}</option>
            {RATIOS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- snapshots

function Snapshots({ photoId, baseId, params, onParams, request }: { photoId: string; baseId: string; params: DevelopParams; onParams: (p: DevelopParams, label: string) => void; request: number }) {
  const qc = useQueryClient()
  const key = ['photo', 'snapshots', photoId]
  const list = useQuery({ queryKey: key, queryFn: () => api.photo.snapshots(photoId) })
  const done = () => qc.invalidateQueries({ queryKey: key })
  const create = useMutation({ mutationFn: (name: string) => api.photo.createSnapshot(photoId, { name, params: compact(params), base_id: baseId }), onSuccess: done })
  const update = useMutation({ mutationFn: ({ id, ...b }: { id: string; name?: string; params?: DevelopParams }) => api.photo.updateSnapshot(id, b), onSuccess: done })
  const remove = useMutation({ mutationFn: api.photo.deleteSnapshot, onSuccess: done })
  const [naming, setNaming] = useState<{ id?: string; name: string } | null>(null)
  // "+" and Ctrl+Alt+N ask for a new one by bumping the counter (state adjusted while rendering, not in an effect)
  const [handled, setHandled] = useState(request)
  if (request !== handled) {
    setHandled(request)
    setNaming({ name: new Date().toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) })
  }

  const submit = () => {
    if (!naming?.name.trim()) return setNaming(null)
    if (naming.id) update.mutate({ id: naming.id, name: naming.name.trim() })
    else create.mutate(naming.name.trim(), { onSuccess: (s) => announce(`Snapshot “${s.name}” saved.`) })
    setNaming(null)
  }
  return (
    <div className="flex flex-col gap-1">
      {naming && (
        <Input
          autoFocus
          aria-label="Snapshot name"
          value={naming.name}
          onChange={(e) => setNaming({ ...naming, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') setNaming(null)
          }}
          onBlur={submit}
          className="h-7"
        />
      )}
      {list.isError && <ErrorState compact error={list.error} />}
      {(list.data ?? []).length === 0 && !naming && <p className="text-[12px] text-studio-muted">Save the current settings by name and come back to them any time (Ctrl+N).</p>}
      <ul className="flex flex-col">
        {(list.data ?? []).map((s: Snapshot) => (
          <li key={s.id} className="group flex items-center rounded-[4px] hover:bg-studio-panel-hover">
            <button type="button" className="min-w-0 flex-1 truncate px-1.5 py-1 text-left text-small" onClick={() => onParams(s.params, `Snapshot: ${s.name}`)} title="Apply this snapshot">
              {s.name}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`${s.name} actions`} className="rounded p-1 text-studio-muted opacity-0 focus-visible:opacity-100 group-hover:opacity-100"><MoreHorizontal className="size-3.5" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => update.mutate({ id: s.id, params: compact(params) }, { onSuccess: () => announce(`“${s.name}” now holds the current settings.`) })}>Update with current settings</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setNaming({ id: s.id, name: s.name })}>Rename</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-studio-danger" onSelect={() => remove.mutate(s.id)}>Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- history

function History({ states, at, onJump }: { states: DevelopParams[]; at: number; onJump: (i: number) => void }) {
  // newest first, like Lightroom
  const rows = states.map((p, i) => ({ i, label: i === 0 ? 'Opened' : stepLabel(states[i - 1], p) })).reverse()
  return (
    <ol className="flex max-h-56 flex-col overflow-y-auto" aria-label="Edit history">
      {rows.map((r) => (
        <li key={r.i}>
          <button
            type="button"
            aria-current={r.i === at ? 'step' : undefined}
            onClick={() => onJump(r.i)}
            className={cn('w-full truncate rounded-[4px] px-1.5 py-0.5 text-left text-small', r.i === at ? 'bg-studio-accent-soft font-medium' : r.i > at ? 'text-studio-muted hover:bg-studio-panel-hover' : 'hover:bg-studio-panel-hover')}
          >
            {r.label}
          </button>
        </li>
      ))}
    </ol>
  )
}

// ---------------------------------------------------------------- the panel

interface Props {
  photoId: string
  baseId: string
  params: DevelopParams
  navigator: ReactNode
  presets: ReactNode
  timeline: { states: DevelopParams[]; at: number }
  onJump: (i: number) => void
  onParams: (p: DevelopParams, label: string) => void
  open: Record<string, boolean>
  onOpen: (id: string, open: boolean) => void
  snapshotRequest: number
  onNewSnapshot: () => void
  versions: ReactNode
}

/** Lightroom's Develop left panel: Navigator, Presets, Snapshots, History. */
export function LeftPanel({ photoId, baseId, params, navigator, presets, timeline, onJump, onParams, open, onOpen, snapshotRequest, onNewSnapshot, versions }: Props) {
  const section = (id: string, title: string, body: ReactNode, action?: ReactNode) => (
    <Section key={id} title={title} open={open[id] ?? true} onOpenChange={(o) => onOpen(id, o)} action={action}>
      <div className="px-1 pb-2">{body}</div>
    </Section>
  )
  return (
    <div className="flex flex-col divide-y divide-studio-border">
      {section('navigator', 'Navigator', navigator)}
      {section('presets', 'Presets', presets)}
      {section(
        'snapshots',
        'Snapshots',
        <Snapshots photoId={photoId} baseId={baseId} params={params} onParams={onParams} request={snapshotRequest} />,
        <button
          type="button"
          aria-label="New snapshot (Ctrl+N)"
          title="New snapshot (Ctrl+N)"
          onClick={onNewSnapshot}
          className="rounded-[4px] p-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
        >
          <Plus className="size-3.5" />
        </button>,
      )}
      {section('history', 'History', <History states={timeline.states} at={timeline.at} onJump={onJump} />)}
      {section('versions', 'Versions', versions)}
    </div>
  )
}
