import { useId, useState } from 'react'
import { Bookmark, BookmarkPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSavedFilters } from '@/hooks/useLibraryOrg'
import type { MediaKind, SavedFilter } from '@/lib/types'
import { announce } from '@/stores/ui'

export interface LibraryQuery {
  kind: MediaKind
  origin?: string
  q?: string
  tag?: string | null
  favourite?: boolean
  folder_id?: string | null
}

/** Chips for the filters you saved in this library, and "Save this filter" when one is set. */
export function SavedFilters({ current, canSave, onApply }: { current: LibraryQuery; canSave: boolean; onApply: (q: LibraryQuery) => void }) {
  const uid = useId()
  const { filters, save, remove } = useSavedFilters()
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const mine = filters.filter((f) => !f.query.kind || f.query.kind === current.kind)

  const apply = (f: SavedFilter) => {
    onApply({ ...(f.query as Partial<LibraryQuery>), kind: current.kind })
    announce(`Showing ${f.name}.`)
  }

  if (!mine.length && !canSave) return null
  return (
    <div role="group" aria-label="Saved filters" className="flex flex-wrap items-center gap-1">
      {mine.length > 0 && <span className="section-label mr-1">Saved</span>}
      {mine.map((f) => (
        <span key={f.id} className="inline-flex h-7 items-center rounded-[6px] border border-studio-border-strong bg-studio-raised text-small">
          <button type="button" onClick={() => apply(f)} className="inline-flex h-full items-center gap-1 rounded-l-[6px] px-2 hover:bg-studio-panel-hover">
            <Bookmark aria-hidden className="size-3 text-studio-accent-hover" />
            {f.name}
          </button>
          <button
            type="button"
            aria-label={`Forget the saved filter ${f.name}`}
            onClick={() => remove.mutate(f.id, { onSuccess: () => announce(`Forgot ${f.name}.`) })}
            className="inline-flex h-full items-center rounded-r-[6px] px-1 text-studio-muted hover:bg-studio-panel-hover hover:text-studio-text"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      {canSave && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="inline-flex h-7 items-center gap-1 rounded-[6px] px-2 text-small text-studio-accent-hover hover:bg-studio-panel-hover">
            <BookmarkPlus aria-hidden className="size-3.5" />
            Save this filter
          </PopoverTrigger>
          <PopoverContent aria-label="Save this filter" className="w-72">
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                const n = name.trim()
                if (!n) return
                const { kind, origin, q, tag, favourite, folder_id } = current
                const query = Object.fromEntries(Object.entries({ kind, origin, q, tag, favourite, folder_id }).filter(([, v]) => v != null && v !== '' && v !== false))
                save.mutate(
                  { name: n, query },
                  {
                    onSuccess: () => {
                      announce(`Saved the filter ${n}.`)
                      setName('')
                      setOpen(false)
                    },
                  },
                )
              }}
            >
              <label htmlFor={`${uid}-name`} className="text-small font-medium">
                Name
              </label>
              <Input id={`${uid}-name`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring b-roll" autoFocus />
              {save.isError && (
                <p role="alert" className="text-small text-studio-danger">
                  {save.error.message}
                </p>
              )}
              <Button type="submit" variant="primary" size="sm" loading={save.isPending} disabled={!name.trim()}>
                Save
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
