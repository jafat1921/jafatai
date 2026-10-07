import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGenerationActions, useGenerations } from '@/hooks/useGenerations'
import type { Generation, GenerationKind } from '@/lib/types'
import { announce } from '@/stores/ui'

interface Props {
  shotId: string
  kind: GenerationKind
  // the card's current version (approved, else newest ready)
  current: Generation | null | undefined
  shownId: string | undefined
  onShow: (g: Generation | undefined) => void
  label: string
  // lists are fetched only where it's worth it (one scene's shots, not the whole film)
  enabled: boolean
}

/** ‹ v2/5 › on a card: look through earlier versions in place, and make one current (approve) without leaving. */
export function VersionFlip({ shotId, kind, current, shownId, onShow, label, enabled }: Props) {
  const list = useGenerations({ targetType: 'shot', targetId: enabled ? shotId : '', kind }, false)
  const { approve } = useGenerationActions()
  const versions = (list.data ?? []).filter((g) => g.status !== 'failed').sort((a, b) => a.version - b.version)
  if (!current || versions.length < 2) return null
  const shown = versions.find((g) => g.id === shownId) ?? versions.find((g) => g.id === current.id) ?? versions[versions.length - 1]
  const i = versions.indexOf(shown)
  const go = (dir: -1 | 1) => {
    const next = versions[i + dir]
    if (!next) return
    onShow(next.id === current.id ? undefined : next)
    announce(`${label}: version ${next.version} of ${versions.length}${next.id === current.id ? ', the current one' : ''}.`)
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label={`${label} versions`}>
      <Button size="icon-sm" variant="ghost" className="size-6" aria-label={`Previous version of ${label}`} disabled={i <= 0} onClick={() => go(-1)}>
        <ChevronLeft aria-hidden />
      </Button>
      <span className="font-mono text-small text-studio-muted" aria-live="polite">
        v{shown.version}/{versions.length}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        className="size-6"
        aria-label={`Next version of ${label}`}
        disabled={i >= versions.length - 1}
        onClick={() => go(1)}
      >
        <ChevronRight aria-hidden />
      </Button>
      {shown.id !== current.id && shown.status === 'ready' && (
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-1.5"
          loading={approve.isPending}
          onClick={() =>
            approve.mutate(shown.id, {
              onSuccess: () => {
                onShow(undefined)
                announce(`${label}: version ${shown.version} approved.`)
              },
            })
          }
        >
          Use v{shown.version}
        </Button>
      )}
    </div>
  )
}
