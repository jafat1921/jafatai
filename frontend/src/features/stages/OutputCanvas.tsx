import { Link } from 'react-router'
import { Film } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useRenders } from '@/hooks/useReel'
import { useProjectAspectClass } from '@/lib/aspect'
import { cn, timeAgo } from '@/lib/utils'
import { useProjectId } from '@/features/workspace/selection'
import { DownloadButton } from '@/features/reel/ReelRenders'

// TODO: final (upscaled) pass, chapters and EDL/XML export land here next milestone.
export function OutputCanvas() {
  const projectId = useProjectId()
  const renders = useRenders(projectId)
  const aspect = useProjectAspectClass()
  const cut = renders.data?.find((r) => r.status === 'approved')

  return (
    <div className="flex h-full flex-col">
      <header className="px-5 pb-3 pt-4">
        <h1 className="text-title font-display font-semibold">Output</h1>
        <p className="text-small text-studio-muted">
          {cut ? `Current cut: render v${cut.version}, approved ${timeAgo(cut.approved_at ?? cut.created_at)}` : 'The approved film shows here'}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {renders.isPending ? (
          <Skeleton className={cn('w-full max-w-4xl', aspect)} />
        ) : renders.isError ? (
          <ErrorState title="Couldn't load renders" error={renders.error} onRetry={() => renders.refetch()} />
        ) : !cut?.media_url ? (
          <EmptyState
            icon={<Film />}
            title="No approved film yet"
            action={
              <Button asChild variant="primary">
                <Link to={`/projects/${projectId}/reel`}>Go to Reel</Link>
              </Button>
            }
          >
            Assemble a draft in the Reel and approve it. Final renders, chapters and EDL export come later.
          </EmptyState>
        ) : (
          <div className="flex max-w-4xl flex-col gap-2">
            <div className={cn('darkroom w-full overflow-hidden rounded-[6px]', aspect)}>
              <video src={cut.media_url} controls playsInline preload="metadata" className="size-full object-contain" aria-label={`Approved film, version ${cut.version}`} />
            </div>
            <div>
              <DownloadButton render={cut} size="md" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
