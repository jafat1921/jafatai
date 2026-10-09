import { useDeferredValue, useState } from 'react'
import { Clapperboard, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input, fieldClass } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaTile } from '@/components/media/MediaTile'
import { flatItems, useMediaList } from '@/hooks/useMedia'
import { useLookMutations } from '@/hooks/usePhoto'
import { gradeEstimate, skippedOnVideo } from '@/lib/photo/looks'
import type { Look } from '@/lib/photo/types'
import { mediaAlt } from '@/lib/media'
import type { MediaItem } from '@/lib/types'
import { announce } from '@/stores/ui'
import { trackJobs } from '@/stores/toasts'
import { DevelopSlider } from './DevelopSlider'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  looks: Look[]
  lookId: string | null
}

const INTENSITY = { min: 0, max: 100, step: 1, default: 100, label: 'Intensity' }

/** Grade any library video or project render with a look; the job lands in the tray, the result is a new version. */
export function ApplyVideoDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-3xl">{props.open && <Body {...props} />}</DialogContent>
    </Dialog>
  )
}

function Body({ looks, lookId, onOpenChange }: Props) {
  const [id, setId] = useState(lookId ?? looks[0]?.id ?? '')
  const [video, setVideo] = useState<MediaItem | null>(null)
  const [intensity, setIntensity] = useState(100)
  const [q, setQ] = useState('')
  const query = useDeferredValue(q.trim())
  const list = useMediaList({ kind: 'video', include: 'project', ...(query ? { q: query } : {}) })
  const items = flatItems(list.data).filter((m) => m.media_url || m.thumb_url)
  const { applyVideo } = useLookMutations()
  const look = looks.find((l) => l.id === id)
  const skipped = look ? skippedOnVideo(look) : []
  const estimate = video ? gradeEstimate(video.duration_s, video.width, video.height) : null

  const submit = () => {
    if (!look || !video) return
    applyVideo.mutate(
      { id: look.id, generationId: video.generation_id, intensity: intensity / 100 },
      {
        onSuccess: (job) => {
          trackJobs([job], `Look “${look.name}” on ${mediaAlt(video)}`, '/video/library')
          announce(`Grading ${mediaAlt(video)} with ${look.name}. The result arrives as a new version.`)
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <DialogHeader className="mb-0">
        <DialogTitle>Apply a look to a video</DialogTitle>
        <DialogDescription>The graded copy becomes a new version of the video. The sound and the original stay untouched.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Look</span>
          <select className={`${fieldClass} h-8`} value={id} onChange={(e) => setId(e.target.value)}>
            {looks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <DevelopSlider name="video-intensity" label="Intensity" value={intensity} range={INTENSITY} onChange={(v) => setIntensity(v)} className="self-end" />
      </div>
      {skipped.length > 0 && <p className="text-small text-studio-muted">Not carried onto video: {skipped.join(', ')}.</p>}

      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
        <Input type="search" placeholder="Search videos" aria-label="Search videos" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>
      <div className="max-h-[40vh] min-h-32 overflow-y-auto pr-1">
        {list.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="aspect-video" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="No videos yet">Finished renders and uploaded clips show up here.</EmptyState>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3" aria-label="Your videos">
            {items.map((m) => (
              <li key={m.id}>
                <MediaTile item={m} selectable selected={video?.id === m.id} onToggle={() => setVideo(m)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {applyVideo.error && <ErrorState compact title="Couldn't start the grade" error={applyVideo.error} />}
      <DialogFooter className="mt-0 items-center">
        {estimate && <span className="mr-auto text-small text-studio-muted">Takes {estimate} on the CPU</span>}
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!look || !video} loading={applyVideo.isPending} onClick={submit}>
          <Clapperboard aria-hidden />
          Grade video
        </Button>
      </DialogFooter>
    </div>
  )
}
