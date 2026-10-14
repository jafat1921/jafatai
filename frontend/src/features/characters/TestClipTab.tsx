import { useEffect, useId, useState } from 'react'
import { Clapperboard, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/studio/states'
import { AerabButton } from '@/components/text/AerabButton'
import { useMakeTestClip, useTestClip } from '@/hooks/useCharacterStudio'
import { useJobs } from '@/hooks/useJobs'
import { api } from '@/lib/api'
import type { Character, Job } from '@/lib/types'
import { announce } from '@/stores/ui'

// the server's cap: 10 s, less the lead-in and the tail, at about 2.5 words a second (contract-v26)
export const MAX_WORDS = 23

const words = (t: string) => t.split(/\s+/).filter(Boolean).length

function minutesSince(iso: string, now: number) {
  const m = Math.floor((now - new Date(iso.endsWith('Z') ? iso : `${iso}Z`).getTime()) / 60_000)
  return m < 1 ? 'under a minute' : m === 1 ? '1 minute' : `${m} minutes`
}

/** What the clip's job is doing right now, and for how long, so a slow first run doesn't look stuck. */
function ClipProgress({ job }: { job: Job | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-small">
        {job?.message && job.message !== 'Starting' ? job.message : 'Queued'}
        {job && <span className="text-studio-muted"> · {minutesSince(job.created_at, now)} so far</span>}
      </p>
      <Progress value={job && job.progress > 0.02 ? job.progress : null} label="Test clip progress" />
      <p className="text-small text-studio-muted">
        The line is spoken first, then the face is animated. The first clip after the server starts also loads the
        lip-sync model, which can take 5 to 10 minutes; later clips are quicker.
      </p>
    </div>
  )
}

/** A 5–10 s lip-synced clip of the character saying a line in their voice, to check face and voice together. */
export function TestClipTab({ character }: { character: Character }) {
  const uid = useId()
  const clip = useTestClip(character.id)
  const make = useMakeTestClip(character.id)
  const [text, setText] = useState('')
  const [adopted, setAdopted] = useState(false)
  // start from the last line tried, once it has loaded
  if (!adopted && clip.data) {
    setAdopted(true)
    if (clip.data.text) setText(clip.data.text)
  }

  const n = words(text)
  const tooLong = n > MAX_WORDS
  const item = clip.data?.item ?? null
  const busy = item?.status === 'queued' || item?.status === 'generating'
  const { data: jobs } = useJobs()
  const job = item?.generation_id ? jobs?.find((j) => j.generation_id === item.generation_id) : undefined
  const noVoice = !character.voice_id

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <p className="text-small text-studio-muted">
        {character.name} says your line in their voice, lip-synced, from the sheet's close-up (or the portrait when there is no close-up yet).
        The clip is saved to the Library.
      </p>
      {noVoice && (
        <p role="note" className="rounded-[6px] border border-studio-border-strong bg-studio-raised px-3 py-2 text-small">
          {character.name} has no voice yet. Pick or design one on the Voice tab first.
        </p>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim() || tooLong) return
          make.mutate(text.trim(), { onSuccess: () => announce('Making the test clip: the line is spoken first, then animated.') })
        }}
      >
        <Label htmlFor={`${uid}-line`}>Line</Label>
        <Textarea
          id={`${uid}-line`}
          dir="auto"
          rows={2}
          maxLength={300}
          value={text}
          placeholder={`What should ${character.name} say?`}
          aria-describedby={`${uid}-count`}
          aria-invalid={tooLong || undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span id={`${uid}-count`} className={tooLong ? 'text-small text-studio-danger' : 'text-small text-studio-muted'}>
            {n} of {MAX_WORDS} words{tooLong ? ': too long for a 10-second clip' : ''}
          </span>
          <AerabButton text={text} onText={setText} target="the line" showNote={false} className="ml-auto" />
        </div>
        {make.isError && <ErrorState compact title="Couldn't make the test clip" error={make.error} />}
        <Button type="submit" variant="primary" className="self-start" loading={make.isPending || busy} disabled={noVoice || !text.trim() || tooLong}>
          <Clapperboard aria-hidden />
          Make test clip
        </Button>
      </form>

      <section aria-label="Test clip" aria-busy={busy || undefined} className="flex flex-col gap-2">
        <div role="status">
          {busy && <ClipProgress job={job} />}
          {item?.status === 'failed' && (
            <p className="text-small text-studio-danger">
              The clip didn't render{job?.error ? `: ${job.error}` : ''}. Try again.
            </p>
          )}
        </div>
        {item?.status === 'ready' && item.media_url && (
          <>
            <video
              controls
              src={item.media_url}
              poster={item.thumb_url ?? undefined}
              className="w-full max-w-md rounded-[6px] border border-studio-border-strong bg-studio-raised"
              aria-label={`Test clip: ${character.name} saying “${clip.data?.text ?? ''}”`}
            />
            {item.generation_id && (
              <Button asChild variant="secondary" className="self-start">
                <a href={api.reel.downloadUrl(item.generation_id)} download>
                  <Download aria-hidden />
                  Download clip
                </a>
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  )
}
