import { useCharacters } from '@/hooks/useCharacters'
import { useResolveSuggestion, useSuggestions } from '@/hooks/useAi'
import { announce } from '@/stores/ui'
import { SuggestionCard } from '@/features/script/SuggestionCard'

// Descriptions the user wrote are never overwritten by "Extract from script"; differences land here instead.
export function CharacterSuggestions({ projectId }: { projectId: string }) {
  const { data } = useSuggestions(projectId)
  const characters = useCharacters(projectId).data ?? []
  const resolve = useResolveSuggestion(projectId)
  const mine = (data ?? []).filter((s) => s.target_type === 'character')
  if (mine.length === 0) return null

  return (
    <div className="flex flex-col gap-3 px-5 pb-4">
      {mine.map((s, i) => {
        const c = characters.find((x) => x.id === s.target_id)
        const act = (accept: boolean) =>
          !resolve.isPending &&
          resolve.mutate({ id: s.id, accept }, { onSuccess: () => announce(accept ? 'Description updated.' : 'Suggestion rejected.') })
        return (
          <div key={s.id}>
            <p className="mb-1 font-display text-panel font-semibold">{c?.name ?? 'Character'}</p>
            <SuggestionCard
              suggestion={s}
              currentText={c?.description}
              shortcuts={i === 0}
              busy={resolve.isPending && resolve.variables?.id === s.id}
              error={resolve.isError && resolve.variables?.id === s.id ? resolve.error : undefined}
              onAccept={() => act(true)}
              onReject={() => act(false)}
            />
          </div>
        )
      })}
    </div>
  )
}
