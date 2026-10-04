import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/studio/states'
import { ShortcutHelp, type Shortcut } from '@/components/studio/shortcut-help'
import { StatusPill } from '@/components/studio/status-pill'
import { useSyncReel } from '@/hooks/useReel'
import { formatTimecode } from '@/lib/duration'
import { clipCount, staleSceneCount } from '@/lib/reel'
import { generationStatus } from '@/lib/status'
import type { Reel } from '@/lib/types'
import { modKey } from '@/lib/keyboard'
import { plural, timeAgo } from '@/lib/utils'
import { announce } from '@/stores/ui'

const SHORTCUTS: Shortcut[] = [
  [['I'], 'set the in point of the selected clip at the playhead'],
  [['O'], 'set the out point at the playhead'],
  [[modKey, 'Enter'], 'stitch the selected scenes (inside the Stitch panel)'],
]

export function ReelHeader({ reel, projectId }: { reel: Reel; projectId: string }) {
  const sync = useSyncReel(projectId)
  const clips = clipCount(reel)
  const stale = staleSceneCount(reel)
  const last = reel.last_render

  return (
    <header className="flex flex-col gap-2 px-5 pb-3 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-1 text-title font-display font-semibold">
            Reel · <span className="font-mono text-[20px]">{formatTimecode(reel.duration_s)}</span>
            <ShortcutHelp shortcuts={SHORTCUTS} />
          </h1>
          <p className="text-small text-studio-muted">
            {plural(clips, 'clip')} · {stale ? `${plural(stale, 'scene')} to rebuild` : 'all scenes up to date'} ·{' '}
            {last ? (
              <span className="inline-flex items-center gap-1 align-middle">
                full film v{last.version} {timeAgo(last.created_at)}
                <StatusPill status={generationStatus(last.status)} />
              </span>
            ) : (
              'full film not stitched yet'
            )}
          </p>
        </div>
        <Button
          variant="secondary"
          loading={sync.isPending}
          onClick={() => sync.mutate(undefined, { onSuccess: () => announce('Reel synced with approved takes.') })}
        >
          <RefreshCw aria-hidden />
          Sync with approved takes
        </Button>
      </div>
      {sync.isError && <ErrorState compact title="Couldn't sync the reel" error={sync.error} />}
    </header>
  )
}
