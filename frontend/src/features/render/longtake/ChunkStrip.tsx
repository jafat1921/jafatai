import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Clock, Dices, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { qk } from '@/hooks/keys'
import { upsertJob } from '@/hooks/useJobs'
import { api } from '@/lib/api'
import { chunkSummary, fmtT, rerollCount, rerollSeconds } from '@/lib/longtake'
import { formatEstimate } from '@/lib/shots'
import { chunkStatus } from '@/lib/status'
import type { ChunkStatus, Generation, TakeChunk } from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'

const ICON: Record<ChunkStatus, React.ComponentType<{ className?: string }>> = {
  queued: Clock,
  generating: Loader2,
  done: Check,
  failed: AlertTriangle,
}

const CELL: Record<ChunkStatus, string> = {
  queued: 'border-studio-border-strong text-studio-muted',
  generating: 'border-studio-accent bg-studio-accent-soft text-studio-accent-hover',
  done: 'border-studio-success/60 text-studio-success',
  failed: 'border-studio-danger bg-studio-danger/10 text-studio-danger',
}

function useRerollChunk() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ take, idx }: { take: Generation; idx: number }) => api.generations.regenerateChunk(take.id, idx),
    onSuccess: (job, { take }) => {
      upsertJob(qc, job)
      qc.invalidateQueries({ queryKey: qk.generationsFor('shot', take.target_id, 'take') })
    },
  })
}

/** One cell per chunk of a long take, laid out on the same time axis as the beats bar. */
export function ChunkStrip({ take, chunks, jobProgress }: { take: Generation; chunks: TakeChunk[]; jobProgress?: number }) {
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null)
  const reroll = useRerollChunk()
  const busy = chunks.some((c) => c.status === 'generating') || take.status === 'queued'
  const chunk = chunks.find((c) => c.idx === selected) ?? chunks.find((c) => c.status === 'failed')

  const total = chunks.length
  const confirmCount = confirmIdx === null ? 0 : rerollCount(chunks, confirmIdx)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="section-label">Chunks</span>
        <span className="text-small text-studio-muted" aria-live="polite">
          {chunkSummary(chunks)}
        </span>
      </div>
      <ol aria-label="Chunks of this take" className="flex gap-0.5">
        {chunks.map((c) => {
          const Icon = ICON[c.status]
          const progress = c.status === 'generating' ? (c.progress ?? jobProgress) : undefined
          const view = chunkStatus(c.status, progress)
          return (
            <li key={c.idx} style={{ flexGrow: Math.max(0.1, c.t_end - c.t_start), flexBasis: 0 }} className="min-w-5">
              <button
                type="button"
                aria-pressed={chunk?.idx === c.idx}
                aria-label={`Chunk ${c.idx + 1}, ${fmtT(c.t_start)} to ${fmtT(c.t_end)}: ${view.label}`}
                title={`Chunk ${c.idx + 1}: ${view.label}`}
                onClick={() => setSelected(c.idx)}
                className={cn(
                  'relative flex h-8 w-full items-center justify-center gap-0.5 overflow-hidden rounded-[4px] border text-small',
                  CELL[c.status],
                  chunk?.idx === c.idx && 'ring-2 ring-studio-accent ring-offset-1 ring-offset-studio-panel',
                )}
              >
                <Icon aria-hidden className={cn('size-3', c.status === 'generating' && 'animate-spin')} />
                <span className="font-mono">{c.idx + 1}</span>
                {typeof progress === 'number' && (
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-0 h-0.5 bg-studio-accent"
                    style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }}
                  />
                )}
              </button>
            </li>
          )
        })}
      </ol>

      {chunk && (
        <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-border bg-studio-raised px-2 py-1.5">
          <span className="text-small">
            Chunk {chunk.idx + 1} · {fmtT(chunk.t_start)}–{fmtT(chunk.t_end)}
            {chunk.seed != null && <span className="font-mono text-studio-muted"> · seed {chunk.seed}</span>}
          </span>
          <StatusPill status={chunkStatus(chunk.status, chunk.progress)} />
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            disabled={busy || chunk.status === 'queued'}
            loading={reroll.isPending}
            onClick={() => setConfirmIdx(chunk.idx)}
          >
            <Dices aria-hidden />
            Re-roll from chunk {chunk.idx + 1}
          </Button>
        </div>
      )}
      {reroll.isError && <ErrorState compact title="Couldn't re-roll" error={reroll.error} />}

      <ConfirmDialog
        open={confirmIdx !== null}
        onOpenChange={(o) => !o && setConfirmIdx(null)}
        title={`Re-roll from chunk ${(confirmIdx ?? 0) + 1}?`}
        description={
          confirmIdx === null ? (
            ''
          ) : (
            <>
              This regenerates {plural(confirmCount, 'chunk')} of {total} (chunk {confirmIdx + 1}
              {confirmCount > 1 ? ` to ${total}` : ''}), because each chunk continues from the end of the one before. The take is
              then joined again. About {formatEstimate(rerollSeconds(chunks, confirmIdx))} on the GPU.
            </>
          )
        }
        confirmLabel={`Re-roll ${plural(confirmCount, 'chunk')}`}
        onConfirm={() => {
          const idx = confirmIdx
          setConfirmIdx(null)
          if (idx === null) return
          reroll.mutate({ take, idx }, { onSuccess: () => announce(`Re-rolling ${plural(rerollCount(chunks, idx), 'chunk')}.`) })
        }}
      />
    </div>
  )
}
