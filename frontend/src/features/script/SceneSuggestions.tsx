import { useResolveSuggestion, useSuggestions } from '@/hooks/useAi'
import type { Scene } from '@/lib/types'
import { announce } from '@/stores/ui'
import { useProjectId } from '@/features/workspace/selection'
import { SuggestionCard } from './SuggestionCard'

type Live = Partial<Pick<Scene, 'heading' | 'logline' | 'script_text'>>

export function SceneSuggestions({ scene, live, beforeAccept }: { scene: Scene; live: Live; beforeAccept: () => Promise<void> }) {
  const projectId = useProjectId()
  const { data } = useSuggestions(projectId)
  const resolve = useResolveSuggestion(projectId)
  const mine = (data ?? []).filter((s) => s.target_type === 'scene' && s.target_id === scene.id)
  if (mine.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {mine.map((s, i) => {
        const busy = resolve.isPending && resolve.variables?.id === s.id
        const act = (accept: boolean) => {
          if (resolve.isPending) return
          // pending keystrokes must land before the accepted text replaces them
          void (accept ? beforeAccept() : Promise.resolve()).then(() =>
            resolve.mutate(
              { id: s.id, accept },
              { onSuccess: () => announce(accept ? 'Suggestion accepted.' : 'Suggestion rejected.') },
            ),
          )
        }
        return (
          <SuggestionCard
            key={s.id}
            suggestion={s}
            currentText={live[s.field as keyof Live]}
            shortcuts={i === 0}
            busy={busy}
            error={resolve.isError && resolve.variables?.id === s.id ? resolve.error : undefined}
            onAccept={() => act(true)}
            onReject={() => act(false)}
          />
        )
      })}
    </div>
  )
}
