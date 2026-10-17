import { useDeferredValue, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { PackageOpen, Plus, Search, User, UsersRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { useStudioCharacters } from '@/hooks/useCharacterStudio'
import { uploadCharacterPack } from '@/lib/upload'
import type { Character } from '@/lib/types'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { NewCharacterDialog } from './NewCharacterDialog'

function CharacterCard({ c }: { c: Character }) {
  const img = c.portrait?.thumb_url ?? c.portrait?.media_url ?? c.board_thumb_url
  const films = c.films ?? []
  return (
    <li className="flex flex-col overflow-hidden rounded-[8px] border border-studio-border-strong bg-studio-panel shadow-card">
      <Link to={`/characters/${c.id}`} className="group flex flex-1 flex-col hover:bg-studio-panel-hover" aria-label={`Open ${c.name}`}>
        <div className="darkroom aspect-[3/4] border-x-0 border-t-0">
          {img ? (
            <img src={img} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
              <User aria-hidden className="size-8" />
            </span>
          )}
        </div>
        <div className="flex flex-col gap-1 p-3">
          <span dir="auto" className="truncate font-display text-panel font-semibold">
            {c.name}
          </span>
          {c.profile?.role && (
            <span dir="auto" className="truncate text-small text-studio-muted">
              {c.profile.role}
            </span>
          )}
          <span className="text-[12px] text-studio-muted">
            {c.panels_ready ? plural(c.panels_ready, 'sheet panel') : 'No sheet yet'}
            {films.length > 0 && ` · in ${plural(films.length, 'film')}`}
          </span>
        </div>
      </Link>
    </li>
  )
}

function ImportPack() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const pick = (file: File | undefined) => {
    if (!file) return
    setProblem(null)
    setProgress(0)
    uploadCharacterPack(file, setProgress)
      .promise.then((c) => {
        qc.invalidateQueries({ queryKey: ['characters', 'studio'] })
        announce(`${c.name} imported.`)
        navigate(`/characters/${c.id}`)
      })
      .catch((e: Error) => setProblem(e.message))
      .finally(() => setProgress(null))
  }
  return (
    <>
      <Button variant="secondary" onClick={() => input.current?.click()} loading={progress !== null}>
        <PackageOpen aria-hidden />
        Import pack
      </Button>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          pick(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {problem && (
        <p role="alert" className="basis-full text-small text-studio-danger">
          {problem}
        </p>
      )}
    </>
  )
}

export function CharacterStudioPage() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const deferred = useDeferredValue(q)
  const list = useStudioCharacters(deferred)
  const [adding, setAdding] = useState(false)
  const rows = list.data ?? []

  return (
    <main data-f6-region tabIndex={-1} className="relative h-full overflow-y-auto focus-visible:outline-none" aria-label="Character Studio">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6 md:px-8">
        <header className="flex flex-wrap items-center gap-3">
          <UsersRound aria-hidden className="size-5 text-studio-accent-hover" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-title font-semibold">Character Studio</h1>
            <p className="text-small text-studio-muted">
              Your cast, shared across films and podcasts: a profile, a reference sheet and a voice for each.
            </p>
          </div>
          <ImportPack />
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            New character
          </Button>
        </header>

        <div className="relative max-w-sm">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-studio-muted" />
          <Input
            type="search"
            aria-label="Search characters"
            placeholder="Search by name or description"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {list.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4" role="status" aria-label="Loading characters">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="aspect-[3/4]" />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          deferred.trim() ? (
            <p className="text-body text-studio-muted" role="status">
              No character matches “{deferred.trim()}”.
            </p>
          ) : (
            <EmptyState
              icon={<UsersRound />}
              title="No characters yet"
              action={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus aria-hidden />
                  New character
                </Button>
              }
            >
              Make a character once and cast them in any film. In a film's Cast you can also save a character here.
            </EmptyState>
          )
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4" aria-label="Characters">
            {rows.map((c) => (
              <CharacterCard key={c.id} c={c} />
            ))}
          </ul>
        )}
      </div>
      <NewCharacterDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(c) => {
          setAdding(false)
          announce(`${c.name} created.`)
          navigate(`/characters/${c.id}`)
        }}
      />
    </main>
  )
}
