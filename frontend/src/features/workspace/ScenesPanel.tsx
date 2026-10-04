import { ArrowDown, ArrowUp, Clapperboard, Plus, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { SourceBadge } from '@/components/studio/source-badge'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useReorderScenes } from '@/hooks/useScenes'
import type { Scene } from '@/lib/types'
import { cn, humanize } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { SceneMetaChips } from './SceneMetaChips'
import { ScriptAiActions } from '@/features/script/ScriptAiActions'
import { useProjectId, useSelectedScene } from './selection'
import { useAddScene } from './useAddScene'

export function AddSceneButton() {
  const { add, pending } = useAddScene()
  return (
    <Tooltip content="Add scene">
      <Button size="icon-sm" variant="ghost" aria-label="Add scene" onClick={add} loading={pending}>
        <Plus aria-hidden />
      </Button>
    </Tooltip>
  )
}

function sceneTitle(s: Scene) {
  return s.heading?.trim() || 'Untitled scene'
}

function SceneCard({
  scene,
  index,
  count,
  selected,
  onSelect,
  onMove,
}: {
  scene: Scene
  index: number
  count: number
  selected: boolean
  onSelect: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const title = sceneTitle(scene)
  const meta = [scene.time_of_day && humanize(scene.time_of_day), scene.mood && humanize(scene.mood)].filter(Boolean)
  return (
    <div
      className={cn(
        'group flex rounded-[6px] border shadow-card transition-colors duration-150',
        selected
          ? 'border-studio-accent bg-studio-accent-soft'
          : 'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="min-w-0 flex-1 rounded-l-[6px] px-2.5 py-2 text-left"
      >
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-small text-studio-muted">{index + 1}</span>
          <span className="truncate text-body font-medium">{title}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <SourceBadge source={scene.source} locked={scene.locked} />
          {meta.length > 0 && <span className="truncate text-small text-studio-muted">{meta.join(' · ')}</span>}
        </span>
        {scene.stale && (
          <span className="mt-1 inline-flex items-center gap-1 text-small text-studio-warning">
            <RefreshCcw aria-hidden className="size-3" />
            Stale
          </span>
        )}
      </button>
      {/* buttons instead of drag so reordering works by keyboard and screen reader */}
      <div className="flex flex-col justify-center gap-0.5 pr-1 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6"
          data-scene-move={`${scene.id}:up`}
          aria-label={`Move scene ${index + 1} up`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6"
          data-scene-move={`${scene.id}:down`}
          aria-label={`Move scene ${index + 1} down`}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown aria-hidden />
        </Button>
      </div>
    </div>
  )
}

export function ScenesPanel() {
  const projectId = useProjectId()
  const { scenes, scene: selected, select } = useSelectedScene()
  const reorder = useReorderScenes(projectId)
  const { add, pending, error: addError } = useAddScene()
  const list = scenes.data ?? []

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir
    if (target < 0 || target >= list.length) return
    const ids = list.map((s) => s.id)
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    const id = list[index].id
    reorder.mutate(ids, { onSuccess: () => announce(`Scene moved to position ${target + 1}.`) })
    // keep keyboard focus on the moved scene; the arrow may be disabled at an edge, so fall back
    requestAnimationFrame(() => {
      const prefer = document.querySelector<HTMLButtonElement>(`[data-scene-move="${id}:${dir < 0 ? 'up' : 'down'}"]`)
      const other = document.querySelector<HTMLButtonElement>(`[data-scene-move="${id}:${dir < 0 ? 'down' : 'up'}"]`)
      ;(prefer && !prefer.disabled ? prefer : other)?.focus()
    })
  }

  if (scenes.isPending) {
    return (
      <div className="flex flex-col gap-2 p-2" role="status" aria-label="Loading scenes">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    )
  }
  if (scenes.isError) {
    return (
      <div className="p-2">
        <ErrorState compact error={scenes.error} onRetry={() => scenes.refetch()} />
      </div>
    )
  }
  if (list.length === 0) {
    return (
      <EmptyState
        icon={<Clapperboard />}
        title="No scenes yet"
        action={
          <Button size="sm" variant="primary" onClick={add} loading={pending}>
            <Plus aria-hidden />
            Add scene
          </Button>
        }
      >
        A film is a list of scenes. Start with one.
      </EmptyState>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-2">
        <ScriptAiActions projectId={projectId} scenes={list} />
        {(reorder.isError || addError) && (
          <ErrorState compact title="Scene change didn't save" error={reorder.error ?? addError} />
        )}
        <ol className="flex flex-col gap-1.5" aria-label="Scenes in order">
          {list.map((s, i) => (
            <li key={s.id}>
              <SceneCard
                scene={s}
                index={i}
                count={list.length}
                selected={s.id === selected?.id}
                onSelect={() => select(s.id)}
                onMove={(dir) => move(i, dir)}
              />
              {s.id === selected?.id && <SceneMetaChips scene={s} />}
            </li>
          ))}
        </ol>
      </div>
    </ScrollArea>
  )
}
