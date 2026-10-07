import { useId, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { Brush, Images } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { MediaGrid } from '@/components/media/MediaGrid'
import { flatItems, useImageEdit, useMediaList } from '@/hooks/useMedia'
import { addSources, editPayload, MAX_EDIT_SOURCES } from '@/lib/images'
import { modKey } from '@/lib/keyboard'
import type { ImageAspect, MediaItem } from '@/lib/types'
import { plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { CountPicker, ImageAspectTiles, ModelLine } from './controls'
import { EditSources } from './EditSources'

const idsFrom = (raw: string | null) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export function ImageEditPage() {
  const uid = useId()
  const [params] = useSearchParams()
  const location = useLocation()
  const fromState = (location.state as { sources?: string[] } | null)?.sources ?? []
  // ?sources=a,b from a tile's Edit button or the References page; never more than three
  const [ids, setIds] = useState<string[]>(() => addSources([], [...idsFrom(params.get('sources')), ...fromState]).ids)
  const [notice, setNotice] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [count, setCount] = useState(1)
  const [aspect, setAspect] = useState<ImageAspect | null>(null)
  const edit = useImageEdit()
  const results = useMediaList({ kind: 'image', origin: 'generated' })

  const add = (items: MediaItem[]) => {
    const next = addSources(ids, items.map((m) => m.id))
    setIds(next.ids)
    setNotice(next.dropped ? `Only ${MAX_EDIT_SOURCES} images can be used at once, so ${next.dropped === 1 ? "1 image wasn't" : `${next.dropped} images weren't`} added.` : null)
  }
  const canSubmit = ids.length > 0 && instruction.trim().length >= 3 && !edit.isPending

  const submit = () => {
    if (!canSubmit) return
    edit.mutate(editPayload(ids, instruction, count, aspect), {
      onSuccess: ({ items }) => announce(`Editing. ${plural(items?.length ?? count, 'result')} on the way.`),
    })
  }

  return (
    <main data-f6-region tabIndex={-1} className="h-full overflow-y-auto focus-visible:outline-none" aria-label="Edit image">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:px-8">
        <form
          aria-labelledby={`${uid}-title`}
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              submit()
            }
          }}
          className="flex flex-col gap-4 rounded-[8px] border border-studio-border-strong bg-studio-panel p-4 shadow-card"
        >
          <div className="flex items-center gap-2">
            <Brush aria-hidden className="size-4 text-studio-accent-hover" />
            <h1 id={`${uid}-title`} className="font-display text-title font-semibold">
              Edit Image
            </h1>
          </div>
          <ModelLine
            name="Qwen-Image-Edit 2511"
            badge="BEST"
            note="Edit and combine up to 3 references"
            highlighted={params.get('model') === 'qwen-image-edit'}
          />
          <EditSources
            ids={ids}
            notice={notice}
            onAdd={add}
            onRemove={(id) => {
              setIds((cur) => cur.filter((x) => x !== id))
              setNotice(null)
            }}
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-instr`}>What should change?</Label>
            <Textarea
              id={`${uid}-instr`}
              rows={3}
              maxLength={2000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={ids.length > 1 ? 'e.g. Put the woman from image 1 in the jacket from image 2, on the street from image 3' : 'e.g. Make it night, with rain on the window'}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
            <ImageAspectTiles value={aspect} onChange={setAspect} allowAuto />
            <CountPicker value={count} onChange={setCount} />
          </div>
          {edit.isError && <ErrorState compact title="Couldn't start the edit" error={edit.error} />}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p className="mr-auto text-small text-studio-muted">
              {ids.length ? 'The result is a new image; your sources stay as they are.' : 'Add at least one source image.'}
            </p>
            <Button type="submit" size="lg" variant="primary" disabled={!canSubmit} loading={edit.isPending} aria-keyshortcuts="Control+Enter">
              <Brush aria-hidden />
              Edit
              <Kbd>{modKey}+Enter</Kbd>
            </Button>
          </div>
        </form>

        <div>
          <h2 className="section-label mb-3">Your images</h2>
          <MediaGrid
            label="Results"
            items={flatItems(results.data)}
            loading={results.isPending}
            error={results.isError ? results.error : undefined}
            onRetry={() => results.refetch()}
            hasMore={results.hasNextPage}
            loadingMore={results.isFetchingNextPage}
            onLoadMore={() => results.fetchNextPage()}
            empty={
              <EmptyState icon={<Images />} title="Nothing edited yet">
                Pick a source, say what to change, and the results land here.
              </EmptyState>
            }
          />
        </div>
      </div>
    </main>
  )
}
