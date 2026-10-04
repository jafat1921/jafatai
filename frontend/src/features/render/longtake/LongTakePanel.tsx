import { useState } from 'react'
import { Sparkles, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/studio/states'
import { useAiJob } from '@/hooks/useAi'
import { useJob } from '@/hooks/useJobs'
import { useUpdateShot } from '@/hooks/useShots'
import { api } from '@/lib/api'
import { formatDuration } from '@/lib/duration'
import { beatsOutOfDate, chunksOf, editBeat, setBeatLock } from '@/lib/longtake'
import type { Beat, Generation, Shot } from '@/lib/types'
import { announce } from '@/stores/ui'
import { BeatEditor, BeatsBar } from './BeatsBar'
import { ChunkStrip } from './ChunkStrip'

interface Props {
  shot: Shot
  label: string
  take: Generation | undefined
  startApproved: boolean
  endApproved: boolean
}

/** PLAN §7.1: beats over a timeline, frame markers, and the chunk strip of the take being viewed. */
export function LongTakePanel({ shot, label, take, startApproved, endApproved }: Props) {
  const update = useUpdateShot(shot.project_id)
  const ai = useAiJob((id: string) => api.ai.beats(id))
  const job = useJob(take?.job_id)
  const beats = shot.beats ?? []
  const [selected, setSelected] = useState(0)
  const index = Math.min(selected, Math.max(0, beats.length - 1))
  const chunks = chunksOf(take)
  const lockedCount = beats.filter((b) => b.locked).length

  const saveBeats = (next: Beat[]) => update.mutate({ id: shot.id, patch: { beats: next } })

  return (
    <section aria-labelledby="longtake-h" className="flex flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="longtake-h" className="flex-1 font-display text-panel font-semibold">
          Long take · {formatDuration(shot.duration_s)}
        </h3>
        <Button
          size="sm"
          variant="secondary"
          loading={ai.working}
          onClick={() => {
            ai.run(shot.id)
            announce('Writing beats for this take.')
          }}
          title={lockedCount ? `Keeps your ${lockedCount} locked beat(s)` : undefined}
        >
          <Sparkles aria-hidden />
          {beats.length ? 'Rewrite beats with AI' : 'Write beats with AI'}
        </Button>
      </div>
      <p className="text-small text-studio-muted">
        Beats are the action prompts for each part of the take, from the approved START to the END frame.
        {!beats.length && ' Without beats, the AI writes them when the take starts.'}
      </p>

      <BeatsBar
        beats={beats}
        durationS={shot.duration_s}
        label={label}
        startApproved={startApproved}
        endApproved={endApproved}
        selected={index}
        onSelect={setSelected}
      />
      {beatsOutOfDate(beats, shot.duration_s) && (
        <p className="flex items-start gap-1.5 text-small text-studio-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          These beats were written for a different length. Unlocked beats are rewritten on the next render.
        </p>
      )}
      {beats[index] && (
        <BeatEditor
          key={index}
          beat={beats[index]}
          index={index}
          saving={update.isPending}
          onSave={(prompt) => saveBeats(editBeat(beats, index, prompt))}
          onLock={(locked) => saveBeats(setBeatLock(beats, index, locked))}
        />
      )}
      {update.isError && <ErrorState compact title="Couldn't save the beat" error={update.error} />}
      {ai.error && <ErrorState compact title="Couldn't write beats" error={ai.error} />}

      {take && chunks.length > 0 && <ChunkStrip take={take} chunks={chunks} jobProgress={job?.progress} />}
      {!endApproved && (
        <p className="text-small text-studio-muted">No approved END frame: the take ends wherever the motion goes.</p>
      )}
    </section>
  )
}
