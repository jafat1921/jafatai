import { useId, useState } from 'react'
import { Lock, Pencil, Plus, Stamp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fieldClass, Input } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useBrandKit } from '@/hooks/useBrandKits'
import { useProject } from '@/hooks/useProjects'
import { useUpdateShot } from '@/hooks/useShots'
import { placeableAssets, placementsLocked, placementsOf, projectKitId, type BrandAssetOption, type BrandPlacement } from '@/lib/brand'
import type { Shot } from '@/lib/types'
import { cn } from '@/lib/utils'
import { announce } from '@/stores/ui'

const MAX_PLACEMENTS = 12

function PlacementForm({ assets, initial, onSave }: { assets: BrandAssetOption[]; initial?: BrandPlacement; onSave: (p: BrandPlacement) => void }) {
  const uid = useId()
  const [assetId, setAssetId] = useState(initial?.asset_id ?? assets[0]?.id ?? '')
  const [surface, setSurface] = useState(initial?.surface ?? '')
  const [prominence, setProminence] = useState<BrandPlacement['prominence']>(initial?.prominence ?? 'hero')
  const asset = assets.find((a) => a.id === assetId)

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${uid}-a`} className="section-label">
        What
      </label>
      <select id={`${uid}-a`} value={assetId} onChange={(e) => setAssetId(e.target.value)} className={cn(fieldClass, 'h-8')}>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <label htmlFor={`${uid}-s`} className="section-label">
        Where in the shot
      </label>
      <Input id={`${uid}-s`} dir="auto" maxLength={200} value={surface} onChange={(e) => setSurface(e.target.value)} placeholder="e.g. printed on the coffee cup sleeve" />
      <span id={`${uid}-p`} className="section-label">
        How prominent
      </span>
      <ToggleGroup type="single" aria-labelledby={`${uid}-p`} value={prominence} onValueChange={(v) => v && setProminence(v as BrandPlacement['prominence'])}>
        <ToggleGroupItem value="hero" className="px-2">
          Hero
        </ToggleGroupItem>
        <ToggleGroupItem value="background" className="px-2">
          Background
        </ToggleGroupItem>
      </ToggleGroup>
      <p className="text-small text-studio-muted">{prominence === 'hero' ? 'Front and centre, sharp. The camera moves slowly so it holds.' : 'Visible in the scene, not the focus.'}</p>
      <div className="flex justify-end gap-2">
        <PopoverClose asChild>
          <Button type="button" size="sm" variant="ghost">
            Cancel
          </Button>
        </PopoverClose>
        <PopoverClose asChild>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={!asset}
            onClick={() => asset && onSave({ asset_id: asset.id, asset_type: asset.type, surface: surface.trim(), prominence, source: 'user' })}
          >
            {initial ? 'Save' : 'Add'}
          </Button>
        </PopoverClose>
      </div>
    </div>
  )
}

/** Where the brand kit's logo and products appear in this shot. Editing marks them as yours, so a re-plan keeps them. */
export function BrandPlacements({ shot, label }: { shot: Shot; label: string }) {
  const project = useProject(shot.project_id)
  const kitId = projectKitId(project.data?.settings)
  const kit = useBrandKit(kitId).data
  const assets = placeableAssets(kit)
  const placements = placementsOf(shot)
  const update = useUpdateShot(shot.project_id)
  if (!kitId && !placements.length) return null

  const save = (next: BrandPlacement[], message: string) =>
    update.mutate(
      // every placement becomes the user's once they touch the list
      // TODO: stop tagging `source` here once the server reports brand_placements_locked on every shot
      { id: shot.id, patch: { brand_placements: next.map((p) => ({ ...p, source: 'user' as const })) } },
      { onSuccess: () => announce(message) },
    )
  const byId = (id: string) => assets.find((a) => a.id === id)

  return (
    <div role="group" aria-label={`Brand in shot ${label}`} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className="section-label mr-1 inline-flex items-center gap-1">
          <Stamp aria-hidden className="size-3" />
          Brand
        </span>
        {placements.map((p, i) => {
          const a = byId(p.asset_id)
          const name = a?.label ?? (p.asset_type === 'logo' ? 'Logo' : 'Product')
          const text = `${name}${p.surface ? ` · ${p.surface}` : ''}`
          return (
            <span key={`${p.asset_id}-${i}`} className="inline-flex h-7 max-w-full items-center gap-1 rounded-[6px] border border-studio-border-strong bg-studio-raised pl-1 pr-0.5 text-small">
              {a?.url ? <img src={a.url} alt="" className="checker size-5 rounded-[3px] object-contain" /> : <Stamp aria-hidden className="size-3.5 text-studio-muted" />}
              <span className="max-w-48 truncate" title={text}>
                {text}
              </span>
              <span className={cn('rounded-[3px] px-1 text-[11px] leading-4', p.prominence === 'hero' ? 'bg-studio-accent text-studio-accent-fg' : 'border border-studio-border text-studio-muted')}>
                {p.prominence === 'hero' ? 'Hero' : 'Background'}
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" size="icon-sm" variant="ghost" className="size-6" aria-label={`Edit ${text}`} disabled={!assets.length}>
                    <Pencil aria-hidden className="size-3" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent aria-label={`Edit ${name} placement`}>
                  <PlacementForm assets={assets} initial={p} onSave={(np) => save(placements.map((x, j) => (j === i ? np : x)), `${name} placement updated.`)} />
                </PopoverContent>
              </Popover>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="size-6"
                aria-label={`Remove ${text}`}
                onClick={() => save(placements.filter((_, j) => j !== i), `${name} removed from shot ${label}.`)}
              >
                <X aria-hidden className="size-3" />
              </Button>
            </span>
          )
        })}
        {assets.length > 0 && placements.length < MAX_PLACEMENTS && (
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5">
                <Plus aria-hidden />
                Add brand
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="Add a brand placement">
              <PlacementForm assets={assets} onSave={(np) => save([...placements, np], `Brand placement added to shot ${label}.`)} />
            </PopoverContent>
          </Popover>
        )}
        {kitId && kit && !assets.length && <span className="text-small text-studio-muted">Add a logo or product to the brand kit first.</span>}
      </div>
      {placementsLocked(shot) && placements.length > 0 && (
        <p className="inline-flex items-center gap-1 text-small text-studio-muted">
          <Lock aria-hidden className="size-3" />
          Edited by you; the AI keeps these when it re-plans.
        </p>
      )}
      {update.isError && (
        <p role="alert" className="text-small text-studio-danger">
          Couldn&apos;t save: {update.error.message}
        </p>
      )}
    </div>
  )
}
