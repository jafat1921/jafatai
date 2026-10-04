import { Check, Eye, ImageOff, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { StatusPill } from '@/components/studio/status-pill'
import { generationStatus } from '@/lib/status'
import type { Generation } from '@/lib/types'
import { cn } from '@/lib/utils'
import { promptDiff } from '@/lib/diff'

function scoreText(score: Generation['score']) {
  if (score == null) return null
  if (typeof score === 'number') return score.toFixed(1)
  const overall = score.overall ?? Object.values(score)[0]
  return typeof overall === 'number' ? overall.toFixed(1) : null
}

interface VersionsPanelProps {
  versions: Generation[]
  currentId: string | undefined
  showRejected: boolean
  onShowRejectedChange: (v: boolean) => void
  onMakeCurrent: (g: Generation) => void
  onApprove: (g: Generation) => void
  onRestore: (g: Generation) => void
  subject: string
}

export function VersionsPanel({
  versions,
  currentId,
  showRejected,
  onShowRejectedChange,
  onMakeCurrent,
  onApprove,
  onRestore,
  subject,
}: VersionsPanelProps) {
  const byId = new Map(versions.map((v) => [v.id, v]))

  return (
    <section aria-label="Versions" className="rounded-[6px] border border-studio-border bg-studio-panel p-2">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <span className="section-label">Versions ({versions.length})</span>
        <label className="flex items-center gap-2 text-small text-studio-muted">
          Show rejected
          <Switch checked={showRejected} onCheckedChange={onShowRejectedChange} aria-label="Show rejected versions" />
        </label>
      </div>
      {versions.length === 0 ? (
        <p className="px-1 py-3 text-small text-studio-muted">No versions yet.</p>
      ) : (
        <ScrollArea orientation="horizontal" className="w-full">
          <ol className="flex gap-2 pb-2.5">
            {versions.map((v) => {
              const prev = v.parent_id ? byId.get(v.parent_id) : versions.find((x) => x.version === v.version - 1)
              const diff = promptDiff(prev?.prompt, v.prompt)
              const score = scoreText(v.score)
              const current = v.id === currentId
              return (
                <li
                  key={v.id}
                  className={cn(
                    'flex w-40 shrink-0 flex-col gap-1.5 rounded-[6px] border bg-studio-raised p-1.5',
                    current ? 'border-studio-accent ring-1 ring-studio-accent' : 'border-studio-border-strong',
                    v.status === 'rejected' && 'opacity-70',
                  )}
                >
                  <div className="darkroom aspect-square overflow-hidden rounded-[4px]">
                    {v.media_url ? (
                      <img
                        src={v.media_url}
                        alt={`${subject}, version ${v.version}`}
                        className="size-full object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center text-studio-on-dark-muted">
                        <ImageOff aria-hidden className="size-5" />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-small font-medium">v{v.version}</span>
                    {score && <span className="font-mono text-small text-studio-muted">★ {score}</span>}
                  </div>
                  <StatusPill status={generationStatus(v.status)} className="self-start" />
                  {v.seed != null && (
                    <span className="font-mono text-[12px] text-studio-muted">seed {v.seed}</span>
                  )}
                  {diff && (diff.added.length > 0 || diff.removed.length > 0) && (
                    <p className="line-clamp-2 text-[12px] leading-4" title={v.prompt}>
                      {diff.added.length > 0 && <span className="text-studio-success">+{diff.added.join(' ')} </span>}
                      {diff.removed.length > 0 && (
                        <span className="text-studio-danger line-through">−{diff.removed.join(' ')}</span>
                      )}
                    </p>
                  )}
                  <div className="mt-auto flex flex-wrap gap-1">
                    {!current && (
                      <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onMakeCurrent(v)}>
                        <Eye aria-hidden />
                        Make current
                      </Button>
                    )}
                    {v.status === 'ready' && (
                      <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onApprove(v)}>
                        <Check aria-hidden />
                        Approve
                      </Button>
                    )}
                    {v.status === 'rejected' && (
                      <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onRestore(v)}>
                        <RotateCcw aria-hidden />
                        Restore
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </ScrollArea>
      )}
    </section>
  )
}
