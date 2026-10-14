import { useId, useMemo, useRef, useState } from 'react'
import { Crop as CropIcon, Plus, Scissors, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ErrorState } from '@/components/studio/states'
import { useSheetActions } from '@/hooks/useCharacterStudio'
import type { Character, CharacterSheet, SheetCatalogue, SheetCrop } from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { OwnImageUpload } from './OwnImageUpload'
import { MIN_CROP, SELECT } from './sheet'

type Crop = SheetCrop & { id: number }
type Own = NonNullable<CharacterSheet['own_sheet']>
type Slot = { key: string; label: string }

const FIELDS = [
  ['x', 'X'],
  ['y', 'Y'],
  ['w', 'Width'],
  ['h', 'Height'],
] as const

/** Panel slots a crop can fill, by section: the portrait, the fixed catalogue, and this sheet's named items. */
function useSlots(cat: SheetCatalogue, sheet: CharacterSheet) {
  return useMemo(() => {
    const titles = Object.fromEntries(cat.sections.map((s) => [s.key, s.label]))
    const groups = new Map<string, Slot[]>([['Portrait', [{ key: 'portrait', label: 'Portrait (face)' }]]])
    const add = (section: string, slot: Slot) => {
      const title = titles[section] ?? section
      if (!groups.has(title)) groups.set(title, [])
      if (!groups.get(title)!.some((s) => s.key === slot.key)) groups.get(title)!.push(slot)
    }
    for (const p of cat.panels) add(p.section, { key: p.key, label: p.label })
    for (const p of sheet.panels) add(p.section, { key: p.key, label: p.label })
    const labels = new Map([...groups.values()].flat().map((s) => [s.key, s.label]))
    return { groups: [...groups.entries()], labelOf: (key: string) => labels.get(key) ?? key }
  }, [cat, sheet.panels])
}

function CropTool({ character, own, sheet, cat }: { character: Character; own: Own; sheet: CharacterSheet; cat: SheetCatalogue }) {
  const uid = useId()
  const { cut } = useSheetActions(character.id)
  const slots = useSlots(cat, sheet)
  const [size, setSize] = useState({ w: own.width ?? 0, h: own.height ?? 0 })
  const [crops, setCrops] = useState<Crop[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const nextId = useRef(1)
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; mode: 'draw' | 'move'; x0: number; y0: number; box: Crop } | null>(null)
  const src = own.generation.media_url ?? own.generation.thumb_url ?? ''

  const clamp = (c: Crop): Crop => {
    const w = Math.round(Math.min(Math.max(c.w || 0, MIN_CROP), size.w))
    const h = Math.round(Math.min(Math.max(c.h || 0, MIN_CROP), size.h))
    return { ...c, w, h, x: Math.round(Math.min(Math.max(c.x || 0, 0), size.w - w)), y: Math.round(Math.min(Math.max(c.y || 0, 0), size.h - h)) }
  }
  // typing in a number box isn't clamped until it loses focus, so "120" can be typed through "1"
  const update = (id: number, change: Partial<Crop>, tidy = true) =>
    setCrops((all) => all.map((c) => (c.id === id ? (tidy ? clamp({ ...c, ...change }) : { ...c, ...change }) : c)))
  const freeSlot = () => slots.groups.flatMap(([, s]) => s).find((s) => !crops.some((c) => c.panel === s.key))?.key ?? 'portrait'

  const add = (box?: Partial<Crop>) => {
    const id = nextId.current++
    const c = clamp({ id, panel: freeSlot(), x: size.w / 3, y: size.h / 3, w: size.w / 4, h: size.h / 3, ...box })
    setCrops((all) => [...all, c])
    setSelected(id)
    return c
  }
  const remove = (c: Crop, n: number) => {
    setCrops((all) => all.filter((x) => x.id !== c.id))
    setSelected(null)
    announce(`Crop ${n} removed.`)
  }

  const onKey = (e: React.KeyboardEvent, c: Crop, n: number) => {
    const step = e.shiftKey ? 10 : 1
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(c, n)
      return
    }
    const d = arrows[e.key]
    if (!d) return
    e.preventDefault()
    if (e.altKey) update(c.id, { w: c.w + d[0], h: c.h + d[1] })
    else update(c.id, { x: c.x + d[0], y: c.y + d[1] })
  }

  // pointer: page pixels to the sheet's own pixels
  const at = (e: React.PointerEvent) => {
    const r = frame.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * size.w) / (r.width || 1), y: ((e.clientY - r.top) * size.h) / (r.height || 1) }
  }
  const down = (e: React.PointerEvent, existing?: Crop) => {
    if (e.button !== 0 || !size.w) return
    const p = at(e)
    const box = existing ?? add({ x: p.x, y: p.y, w: MIN_CROP, h: MIN_CROP })
    setSelected(box.id)
    drag.current = { id: box.id, mode: existing ? 'move' : 'draw', x0: p.x, y0: p.y, box }
    frame.current?.setPointerCapture?.(e.pointerId)
    e.preventDefault()
    e.stopPropagation()
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = at(e)
    if (d.mode === 'move') update(d.id, { x: d.box.x + p.x - d.x0, y: d.box.y + p.y - d.y0 })
    else update(d.id, { x: Math.min(p.x, d.x0), y: Math.min(p.y, d.y0), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0) })
  }
  const up = () => {
    drag.current = null
  }

  const save = () => {
    const tidy = crops.map(clamp)
    cut.mutate(
      tidy.map(({ panel, x, y, w, h }) => ({ panel, x, y, w, h })),
      {
        onSuccess: (s) => {
          setCrops([])
          setSelected(null)
          announce(`${plural(s.saved ?? tidy.length, 'panel')} saved from your sheet and approved.`)
        },
      },
    )
  }

  return (
    <section aria-labelledby={`${uid}-h`} className="flex flex-col gap-3">
      <h4 id={`${uid}-h`} className="flex items-center gap-1.5 text-body font-semibold">
        <Scissors aria-hidden className="size-4 text-studio-accent" />
        Cut panels from this sheet
      </h4>
      <p id={`${uid}-help`} className="text-small text-studio-muted">
        Drag on the sheet to draw a box, or press Add a crop. Pick the panel each box fills. On a selected box, arrow keys move it,
        Alt with the arrow keys resizes it (Shift for 10 pixels at a time) and Delete removes it. Boxes are cut from the full-size
        sheet, not this preview.
      </p>
      <div
        ref={frame}
        role="group"
        aria-label="Your sheet"
        aria-describedby={`${uid}-help`}
        className="relative w-full max-w-3xl cursor-crosshair touch-none select-none overflow-hidden rounded-[6px] border border-studio-border-strong"
        onPointerDown={(e) => down(e)}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <img
          src={src}
          alt={`Your uploaded sheet of ${character.name}`}
          draggable={false}
          className="block w-full"
          onLoad={(e) => {
            const im = e.currentTarget
            if (im.naturalWidth) setSize({ w: im.naturalWidth, h: im.naturalHeight })
          }}
        />
        {size.w > 0 &&
          crops.map((c, i) => (
            <button
              key={c.id}
              type="button"
              aria-label={`Crop ${i + 1}: ${slots.labelOf(c.panel)}, ${c.w} by ${c.h} pixels at ${c.x}, ${c.y}`}
              aria-describedby={`${uid}-help`}
              onFocus={() => setSelected(c.id)}
              onKeyDown={(e) => onKey(e, c, i + 1)}
              onPointerDown={(e) => down(e, c)}
              className={cn(
                'absolute cursor-move border-2 border-studio-accent bg-studio-accent/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-studio-text',
                selected === c.id && 'bg-studio-accent/30',
              )}
              style={{ left: `${(c.x / size.w) * 100}%`, top: `${(c.y / size.h) * 100}%`, width: `${(c.w / size.w) * 100}%`, height: `${(c.h / size.h) * 100}%` }}
            >
              <span className="absolute left-0 top-0 bg-studio-accent px-1 text-[11px] font-semibold text-studio-accent-fg">{i + 1}</span>
            </button>
          ))}
      </div>

      {crops.length > 0 && (
        <ol aria-label="Crops" className="flex flex-col gap-2">
          {crops.map((c, i) => (
            <li
              key={c.id}
              className={cn('flex flex-wrap items-end gap-2 rounded-[6px] border border-studio-border bg-studio-raised p-2', selected === c.id && 'border-studio-accent')}
            >
              <span className="self-center text-small font-semibold">Crop {i + 1}</span>
              <div className="flex min-w-44 flex-1 flex-col gap-1">
                <Label htmlFor={`${uid}-${c.id}-panel`}>Panel for crop {i + 1}</Label>
                <select id={`${uid}-${c.id}-panel`} className={SELECT} value={c.panel} onChange={(e) => update(c.id, { panel: e.target.value })}>
                  {slots.groups.map(([title, list]) => (
                    <optgroup key={title} label={title}>
                      {list.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              {FIELDS.map(([k, label]) => (
                <div key={k} className="flex w-20 flex-col gap-1">
                  <Label htmlFor={`${uid}-${c.id}-${k}`}>{label}</Label>
                  <Input
                    id={`${uid}-${c.id}-${k}`}
                    aria-label={`${label} of crop ${i + 1}`}
                    type="number"
                    inputMode="numeric"
                    min={k === 'w' || k === 'h' ? MIN_CROP : 0}
                    max={k === 'x' || k === 'w' ? size.w : size.h}
                    value={c[k]}
                    onChange={(e) => update(c.id, { [k]: Number(e.target.value) }, false)}
                    onBlur={() => update(c.id, {})}
                  />
                </div>
              ))}
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete crop ${i + 1}`} title="Delete" onClick={() => remove(c, i + 1)}>
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => add()} disabled={!size.w}>
          <Plus aria-hidden />
          Add a crop
        </Button>
        <Button type="button" variant="primary" size="sm" onClick={save} disabled={!crops.length} loading={cut.isPending}>
          <CropIcon aria-hidden />
          {crops.length ? `Save ${plural(crops.length, 'panel')}` : 'Save panels'}
        </Button>
        <span className="text-small text-studio-muted">Each saved crop becomes that panel's approved version, used in shots like a made one.</span>
      </div>
      {cut.isError && <ErrorState compact title="Couldn't cut the panels" error={cut.error} />}
    </section>
  )
}

export function OwnSheet({ character, sheet, cat }: { character: Character; sheet: CharacterSheet; cat: SheetCatalogue }) {
  const uid = useId()
  const { uploadSheet } = useSheetActions(character.id)
  const own = sheet.own_sheet
  return (
    <section aria-labelledby={`${uid}-h`} className="flex flex-col gap-3 rounded-[8px] border border-studio-border-strong bg-studio-panel p-4">
      <h3 id={`${uid}-h`} className="font-display text-panel font-semibold">
        Your own sheet
      </h3>
      <p className="text-small text-studio-muted">
        Already have a character sheet or chart? Upload it and it's kept as the board, exactly as it is. Then cut the panels you
        want out of it.
      </p>
      <OwnImageUpload
        label={own ? 'Upload another sheet' : 'Upload your own sheet'}
        title={`Character sheet of ${character.name}`}
        busy={uploadSheet.isPending}
        onUploaded={(m, consent) =>
          uploadSheet.mutate({ media_id: m.id, consent }, { onSuccess: () => announce('Your sheet is the board now. Cut panels from it below.') })
        }
      />
      {uploadSheet.isError && <ErrorState compact title="Couldn't use that sheet" error={uploadSheet.error} />}
      {own && <CropTool key={own.media_id} character={character} own={own} sheet={sheet} cat={cat} />}
    </section>
  )
}
