import { useState } from 'react'
import { Link } from 'react-router'
import { User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ErrorState } from '@/components/studio/states'
import { useCharacters } from '@/hooks/useCharacters'
import { useLinkCharacter, useStudioCharacters } from '@/hooks/useCharacterStudio'
import type { Character } from '@/lib/types'

interface Props {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onLinked: (c: Character) => void
}

/** Cast a Character Studio character in this film. It stays one shared character, not a copy. */
export function CastFromStudioDialog({ projectId, open, onOpenChange, onLinked }: Props) {
  const [q, setQ] = useState('')
  const studio = useStudioCharacters(q)
  const cast = useCharacters(projectId)
  const link = useLinkCharacter(projectId)
  const inFilm = new Set((cast.data ?? []).map((c) => c.id))
  const rows = (studio.data ?? []).filter((c) => !inFilm.has(c.id))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cast from Character Studio</DialogTitle>
          <DialogDescription>Their portrait, sheet and voice come along, and later edits show here too.</DialogDescription>
        </DialogHeader>
        <Input type="search" aria-label="Search Character Studio" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        {studio.isError && <ErrorState compact error={studio.error} onRetry={() => studio.refetch()} />}
        {link.isError && <ErrorState compact title="Couldn't cast the character" error={link.error} />}
        <ul className="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto" aria-label="Studio characters">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-3 rounded-[6px] p-1.5 hover:bg-studio-panel-hover">
              <div className="darkroom size-10 shrink-0 overflow-hidden rounded-full">
                {c.portrait?.thumb_url ? (
                  <img src={c.portrait.thumb_url} alt="" className="size-full object-cover" />
                ) : (
                  <User aria-hidden className="m-auto mt-2.5 size-5 text-studio-on-dark-muted" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div dir="auto" className="truncate font-medium">
                  {c.name}
                </div>
                <div dir="auto" className="truncate text-small text-studio-muted">
                  {c.profile?.role || c.description || 'No description'}
                </div>
              </div>
              <Button size="sm" variant="secondary" loading={link.isPending && link.variables === c.id} onClick={() => link.mutate(c.id, { onSuccess: onLinked })}>
                Cast
              </Button>
            </li>
          ))}
        </ul>
        {studio.isSuccess && rows.length === 0 && (
          <p className="text-small text-studio-muted" role="status">
            {q.trim() ? 'No match.' : 'Everyone in Character Studio is already in this film.'}{' '}
            <Link to="/characters" className="underline underline-offset-2">
              Open Character Studio
            </Link>
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
