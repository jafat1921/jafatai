import { useId } from 'react'
import { Link } from 'react-router'
import { Check, Loader2, User } from 'lucide-react'
import { ImageSourceField } from '@/components/media/ImageSourceField'
import { ErrorState } from '@/components/studio/states'
import { Skeleton } from '@/components/ui/skeleton'
import { useStudioCharacters } from '@/hooks/useCharacterStudio'
import { useJob } from '@/hooks/useJobs'
import { VIEWS } from '@/lib/model3d'
import type { Job, View3D } from '@/lib/types'
import { cn } from '@/lib/utils'

const VIEW_NAMES: Record<View3D, string> = { front: 'Front', left: 'Left side', back: 'Back', right: 'Right side' }

/** A Character Studio character, picked from a list of radio buttons with their portraits. */
export function CharacterPick({ value, onChange, views, sheetLoading }: { value: string | null; onChange: (id: string) => void; views: View3D[]; sheetLoading: boolean }) {
  const uid = useId()
  const list = useStudioCharacters()
  const rows = list.data ?? []
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={`${uid}-h`}>
      <legend className="section-label mb-1.5">Character</legend>
      {list.isError ? (
        <ErrorState compact title="Couldn't load your characters" error={list.error} onRetry={() => list.refetch()} />
      ) : list.isPending ? (
        <Skeleton className="h-24 w-full max-w-sm" />
      ) : rows.length ? (
        <ul className="grid max-h-64 w-full max-w-sm gap-1 overflow-y-auto pr-1">
          {rows.map((c) => (
            <li key={c.id}>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-[6px] border p-1.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-studio-accent',
                  value === c.id ? 'border-studio-accent bg-studio-raised' : 'border-transparent hover:bg-studio-panel-hover',
                )}
              >
                <input type="radio" name={`${uid}-c`} value={c.id} checked={value === c.id} onChange={() => onChange(c.id)} className="sr-only" />
                <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-studio-raised">
                  {c.portrait?.thumb_url ? <img src={c.portrait.thumb_url} alt="" className="size-full object-cover" /> : <User aria-hidden className="size-5 text-studio-faint" />}
                </span>
                <span dir="auto" className="min-w-0 flex-1 truncate font-medium">
                  {c.name}
                </span>
                {value === c.id && <Check aria-hidden className="size-4 text-studio-accent-hover" />}
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-studio-muted">
          No characters yet.{' '}
          <Link to="/characters" className="underline underline-offset-2">
            Open Character Studio
          </Link>
        </p>
      )}
      <p id={`${uid}-h`} role="status" className="max-w-sm text-small text-studio-muted">
        {!value
          ? 'Their turnaround views are used when the sheet has them.'
          : sheetLoading
            ? 'Checking the character sheet…'
            : views.length
              ? `Uses the turnaround views: ${views.map((v) => VIEW_NAMES[v].toLowerCase()).join(', ')}.`
              : 'No turnaround on the sheet yet, so the full-body picture or the portrait is used.'}
      </p>
    </fieldset>
  )
}

/** Four labelled picture slots; only the front one is needed, plus at least one more. */
export function ViewSlots({ value, onChange }: { value: Record<View3D, string | null>; onChange: (view: View3D, id: string | null) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-small text-studio-muted">Square pictures of one object at the same scale, on a plain or black background. Front and one more at least.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {VIEWS.map((v) => (
          <ImageSourceField
            key={v.id}
            label={v.label}
            required={v.id === 'front'}
            value={value[v.id]}
            onChange={(id) => onChange(v.id, id)}
            aspectClass="aspect-square"
            removeLabel={`Remove the ${v.label.toLowerCase()} view`}
            pickDescription={`Pick the ${v.label.toLowerCase()} view of the object.`}
          />
        ))}
      </div>
    </div>
  )
}

const STEP: Record<string, string> = { queued: 'Waiting', running: 'Making…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }

function Step({ n, label, job, waitingFor }: { n: number; label: string; job: Job | undefined; waitingFor?: string }) {
  const status = job?.status ?? 'queued'
  const text = status === 'queued' && waitingFor ? waitingFor : STEP[status] ?? status
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          'flex size-6 items-center justify-center rounded-full border text-small',
          status === 'done' ? 'border-studio-success text-studio-success' : 'border-studio-border-strong text-studio-muted',
        )}
      >
        {status === 'done' ? <Check className="size-3.5" /> : status === 'running' ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : n}
      </span>
      <span className="font-medium">{label}</span>
      <span className={cn('text-small', status === 'failed' ? 'text-studio-danger' : 'text-studio-muted')}>
        {text}
        {status === 'running' && job?.progress ? ` ${Math.round(job.progress * 100)}%` : ''}
      </span>
    </li>
  )
}

/** A text start runs in two steps: the picture, then the model made from it. */
export function TwoSteps({ pictureJob, modelJob }: { pictureJob: Job; modelJob: Job }) {
  const pic = useJob(pictureJob.id) ?? pictureJob
  const model = useJob(modelJob.id) ?? modelJob
  return (
    <ol aria-label="Progress" className="flex flex-col gap-1.5 rounded-[6px] border border-studio-border bg-studio-raised p-2.5">
      <Step n={1} label="Picture" job={pic} />
      <Step n={2} label="3D model" job={model} waitingFor={pic.status === 'done' ? 'Waiting' : 'After the picture'} />
    </ol>
  )
}
