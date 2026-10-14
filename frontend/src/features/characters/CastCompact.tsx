import { useState } from 'react'
import { Link } from 'react-router'
import { ExternalLink, LibraryBig, UserMinus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { ErrorState } from '@/components/studio/states'
import { useCharacterSheet, useDeleteCharacter, useSaveToStudio } from '@/hooks/useCharacterStudio'
import { useVoiceChoices } from '@/hooks/useGallery'
import type { Character } from '@/lib/types'
import { announce } from '@/stores/ui'

// the panels most shots end up using, shown first
const KEY_PANELS = ['hero', 'turn_front', 'closeup', 'expr_neutral', 'expr_smile', 'head_level_lprofile']

/** The film's view of a character: what shots will use, and the way into Character Studio for the rest. */
export function CastCompact({ character, projectId }: { character: Character; projectId: string }) {
  const sheet = useCharacterSheet(character.id)
  const voices = useVoiceChoices()
  const save = useSaveToStudio()
  const unlink = useDeleteCharacter()
  const [confirming, setConfirming] = useState(false)
  const studio = character.project_id === null || character.studio
  const voice = voices.find((v) => v.id === character.voice_id)
  const ready = (sheet.data?.panels ?? []).filter((p) => p.current)
  const shown = [...ready].sort((a, b) => rank(a.key) - rank(b.key)).slice(0, 6)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="section-label mb-1">Description</h3>
        <p dir="auto" className="text-body text-studio-muted">
          {character.description || 'No description yet.'}
        </p>
      </div>

      <div>
        <h3 className="section-label mb-1.5">Sheet panels for shots</h3>
        {shown.length ? (
          <ul className="grid grid-cols-3 gap-2" aria-label="Sheet panels">
            {shown.map((p) => (
              <li key={p.key} className="flex flex-col gap-1">
                <div className="darkroom aspect-[3/4] overflow-hidden rounded-[4px]">
                  <img src={p.current?.thumb_url ?? p.current?.media_url ?? ''} alt="" className="size-full object-cover" loading="lazy" />
                </div>
                <span dir="auto" className="truncate text-[12px]" title={p.label}>
                  {p.label}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-small text-studio-muted">
            No sheet yet. Shots use the approved portrait until there is one; a sheet lets wide shots use the full body and close
            shots the right expression.
          </p>
        )}
        {ready.length > shown.length && <p className="mt-1 text-small text-studio-muted">and {ready.length - shown.length} more</p>}
      </div>

      <div>
        <h3 className="section-label mb-1">Voice</h3>
        <p className="text-body text-studio-muted">{voice ? voice.name : 'No voice picked yet.'}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {studio ? (
          <Button asChild variant="primary" size="sm">
            <Link to={`/characters/${character.id}`}>
              <ExternalLink aria-hidden />
              Open in Character Studio
            </Link>
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            onClick={() =>
              save.mutate(character.id, { onSuccess: () => announce(`${character.name} is in Character Studio now, and still in this film.`) })
            }
          >
            <LibraryBig aria-hidden />
            Save to Character Studio
          </Button>
        )}
        {studio && (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            <UserMinus aria-hidden />
            Remove from this film
          </Button>
        )}
      </div>
      {!studio && (
        <p className="text-small text-studio-muted">
          Saving makes the profile, sheet and voice editable in Character Studio, and lets other films cast them.
        </p>
      )}
      {save.isError && <ErrorState compact title="Couldn't save to Character Studio" error={save.error} />}
      {unlink.isError && <ErrorState compact title="Couldn't remove the character" error={unlink.error} />}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${character.name} from this film?`}
        description="They come off this film's cast and its shots. They stay in Character Studio and in any other film."
        confirmLabel="Remove from film"
        onConfirm={() =>
          unlink.mutate({ id: character.id, projectId }, { onSuccess: () => announce(`${character.name} removed from this film.`) })
        }
      />
    </div>
  )
}

function rank(key: string) {
  const i = KEY_PANELS.indexOf(key)
  return i === -1 ? KEY_PANELS.length : i
}
