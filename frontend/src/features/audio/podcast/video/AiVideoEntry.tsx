import { useId } from 'react'
import { useNavigate } from 'react-router'
import { Clapperboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCreateAiVideo, useEpisodeAiVideo } from '@/hooks/useVideoPodcast'
import type { Episode } from '@/lib/podcast'

/** Publish's way into the AI video workspace: open the one there is, or make it. */
export function AiVideoEntry({ ep }: { ep: Episode }) {
  const uid = useId()
  const nav = useNavigate()
  const existing = useEpisodeAiVideo(ep.id)
  const create = useCreateAiVideo(ep.id)
  const to = `/audio/podcast/${ep.id}/video`
  const why = !ep.outputs.mix ? 'Mix the episode first (step 5).' : !ep.hosts.length ? 'Add the hosts first (step 2).' : null
  const has = !!existing.data

  return (
    <section aria-labelledby={`${uid}-ai`} className="flex flex-col gap-3 rounded-[6px] border border-studio-border-strong bg-studio-panel p-3 shadow-card">
      <h3 id={`${uid}-ai`} className="font-display text-[15px] font-semibold">
        AI video podcast
      </h3>
      <p className="text-[11px] text-studio-muted">Your hosts on camera in a generated set, lip-synced to the mix and cut between angles, step by step.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="primary"
          aria-disabled={(!has && !!why) || existing.isPending || undefined}
          aria-describedby={why && !has ? `${uid}-why` : undefined}
          loading={create.isPending}
          onClick={() => {
            if (existing.isPending) return
            if (has) return nav(to)
            if (why) return
            create.mutate({}, { onSuccess: () => nav(to) })
          }}
        >
          <Clapperboard aria-hidden />
          {has ? 'Open AI video' : 'Make an AI video'}
        </Button>
        {why && !has && (
          <span id={`${uid}-why`} className="text-small text-studio-muted">
            {why}
          </span>
        )}
      </div>
      {(create.error || existing.error) && (
        <p role="alert" className="text-small text-studio-danger">
          {(create.error ?? existing.error)?.message}
        </p>
      )}
    </section>
  )
}
