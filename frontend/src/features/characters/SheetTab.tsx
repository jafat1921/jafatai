import { useId, useMemo, useState } from 'react'
import { AlertTriangle, Download, FileDown, LayoutGrid, Loader2, RefreshCw, User, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { EmptyState, ErrorState } from '@/components/studio/states'
import { StatusPill } from '@/components/studio/status-pill'
import { AerabButton } from '@/components/text/AerabButton'
import { GenerationViewer } from '@/components/review/GenerationViewer'
import { useCharacterSheet, useSheetActions, useSheetCatalogue } from '@/hooks/useCharacterStudio'
import { api } from '@/lib/api'
import { generationStatus, type StatusView } from '@/lib/status'
import type {
  BoardLayout, Character, CharacterSheet, SheetBackdrop, SheetCatalogue, SheetListName, SheetPanel, SheetPreset,
} from '@/lib/types'
import { cn, plural } from '@/lib/utils'
import { announce } from '@/stores/ui'
import { COUNT_LABELS, countPanels, LISTS, minutes, SELECT } from './sheet'

function panelStatus(p: SheetPanel): StatusView {
  if (p.status === 'none') return { label: 'Not made yet', tone: 'neutral', icon: 'clock' }
  if (p.status === 'waiting') return { label: 'Waits for the full body', tone: 'neutral', icon: 'clock' }
  return generationStatus(p.status)
}

// ---------------------------------------------------------------- making a sheet

function SheetBuilder({ character, sheet, cat }: { character: Character; sheet: CharacterSheet; cat: SheetCatalogue }) {
  const uid = useId()
  const { make } = useSheetActions(character.id)
  const [preset, setPreset] = useState<SheetPreset>(sheet.preset ?? 'essential')
  const [backdrop, setBackdrop] = useState<SheetBackdrop>(sheet.backdrop ?? 'grey')
  const [counts, setCounts] = useState<Record<string, number>>(
    sheet.preset === 'custom' ? sheet.counts : { ...cat.presets.essential.counts },
  )
  const [lists, setLists] = useState<Partial<Record<SheetListName, string>>>(
    Object.fromEntries(LISTS.map((l) => [l.key, (sheet.lists[l.key] ?? []).join('\n')])),
  )
  const parsed = useMemo(
    () => Object.fromEntries(LISTS.map((l) => [l.key, (lists[l.key] ?? '').split('\n').map((x) => x.trim()).filter(Boolean)])),
    [lists],
  ) as Partial<Record<SheetListName, string[]>>
  const n = countPanels(cat, preset, counts, parsed)
  const [lo, hi] = cat.seconds_per_panel

  const go = () =>
    make.mutate(
      { preset, backdrop, counts: preset === 'custom' ? counts : undefined, lists: preset === 'essential' ? undefined : parsed },
      { onSuccess: (s) => announce(s.queued ? `${plural(s.queued, 'panel')} queued.` : 'Every panel already has a picture. Regenerate the ones you want to change.') },
    )

  return (
    <section aria-labelledby={`${uid}-h`} className="flex flex-col gap-3 rounded-[8px] border border-studio-border-strong bg-studio-panel p-4">
      <h3 id={`${uid}-h`} className="font-display text-panel font-semibold">Make the sheet</h3>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1.5">
          <span id={`${uid}-preset`} className="section-label">Preset</span>
          <ToggleGroup type="single" value={preset} onValueChange={(v) => v && setPreset(v as SheetPreset)} aria-labelledby={`${uid}-preset`}>
            <ToggleGroupItem value="essential">Essential</ToggleGroupItem>
            <ToggleGroupItem value="full">Full</ToggleGroupItem>
            <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex flex-col gap-1.5">
          <span id={`${uid}-bd`} className="section-label">Backdrop</span>
          <ToggleGroup type="single" value={backdrop} onValueChange={(v) => v && setBackdrop(v as SheetBackdrop)} aria-labelledby={`${uid}-bd`}>
            <ToggleGroupItem value="grey">Studio grey</ToggleGroupItem>
            <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <p className="text-small text-studio-muted">
        {preset === 'essential' && 'Full body, turnaround, four expressions and a close-up.'}
        {preset === 'full' && 'Adds a walking pose, a 15-angle head grid and eight expressions, plus any items you list below.'}
        {preset === 'custom' && 'Pick the sections and how many panels each gets.'} Every panel is an edit of the approved
        portrait or the full body, so the face stays the same.
      </p>

      {preset === 'custom' && (
        <div className="grid gap-3 sm:grid-cols-3">
          {Object.entries(cat.counts).map(([key, allowed]) => (
            <div key={key} className="flex flex-col gap-1">
              <Label htmlFor={`${uid}-c-${key}`}>{COUNT_LABELS[key] ?? key}</Label>
              <select
                id={`${uid}-c-${key}`}
                className={SELECT}
                value={counts[key] ?? 0}
                onChange={(e) => setCounts((c) => ({ ...c, [key]: Number(e.target.value) }))}
              >
                {allowed.map((v) => (
                  <option key={v} value={v}>
                    {v === 0 ? 'None' : v}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {preset !== 'essential' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {LISTS.map((l) => (
            <div key={l.key} className="flex flex-col gap-1">
              <Label htmlFor={`${uid}-l-${l.key}`}>
                {l.label} <span className="font-normal text-studio-muted">(one per line, up to {cat.lists[l.key]})</span>
              </Label>
              <Textarea
                id={`${uid}-l-${l.key}`}
                dir="auto"
                rows={2}
                value={lists[l.key] ?? ''}
                placeholder={l.hint}
                onChange={(e) => setLists((x) => ({ ...x, [l.key]: e.target.value }))}
              />
            </div>
          ))}
          <p className="text-small text-studio-muted sm:col-span-2">
            Props and accessories are drawn as objects on the same backdrop, not worn. Use “Fill from description” on the
            Profile tab to have the AI suggest them.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={go} loading={make.isPending} disabled={!sheet.has_portrait}>
          <Wand2 aria-hidden />
          Make sheet
        </Button>
        <span className="text-small text-studio-muted" aria-live="polite">
          {plural(n, 'panel')} · about {minutes(n * lo)}–{minutes(n * hi)} min on the image GPU. Panels that already have a
          picture are kept.
        </span>
      </div>
      {!sheet.has_portrait && <p className="text-small text-studio-warning">Make and approve a portrait first: every panel is drawn from it.</p>}
      {make.isError && <ErrorState compact title="Couldn't start the sheet" error={make.error} />}
    </section>
  )
}

// ---------------------------------------------------------------- the panels

function PanelDialog({ character, panel, onClose }: { character: Character; panel: SheetPanel; onClose: () => void }) {
  const uid = useId()
  const { patch } = useSheetActions(character.id)
  const [label, setLabel] = useState(panel.label === panel.default_label ? '' : panel.label)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {panel.section_title}: {panel.label}
          </DialogTitle>
          <DialogDescription>Approve the version the board and the shots should use, or regenerate it.</DialogDescription>
        </DialogHeader>
        <GenerationViewer
          target={{ targetType: 'character', targetId: character.id, kind: 'sheet_view', panel: panel.key }}
          subject={`${panel.label} panel of ${character.name}`}
          aspectClass={panel.source === 'none' ? 'aspect-square' : 'aspect-[3/4]'}
          emptyHint="Nothing made for this panel yet."
        />
        <form
          className="mt-3 flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            patch.mutate({ labels: { [panel.key]: label.trim() } }, { onSuccess: () => announce('Label saved.') })
          }}
        >
          <Label htmlFor={`${uid}-label`}>Label on the board</Label>
          <div className="flex gap-2">
            <Input id={`${uid}-label`} dir="auto" maxLength={80} value={label} placeholder={panel.default_label} onChange={(e) => setLabel(e.target.value)} />
            <Button type="submit" variant="secondary" loading={patch.isPending}>
              Save
            </Button>
          </div>
          <AerabButton text={label} onText={setLabel} target="the label" />
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PanelTile({ panel, onOpen, onRegenerate, busy }: { panel: SheetPanel; onOpen: () => void; onRegenerate: () => void; busy: boolean }) {
  const img = panel.current?.thumb_url ?? panel.current?.media_url
  const live = panel.status === 'queued' || panel.status === 'generating'
  return (
    <li className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onOpen}
        className="darkroom relative aspect-[3/4] overflow-hidden rounded-[6px] focus-visible:ring-2 focus-visible:ring-studio-accent"
        aria-label={`Review ${panel.label}`}
      >
        {img ? (
          <img src={img} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <span className="flex size-full items-center justify-center text-studio-on-dark-muted">
            {live ? <Loader2 aria-hidden className="size-5 animate-spin" /> : <User aria-hidden className="size-5" />}
          </span>
        )}
        {panel.stale && (
          <span className="absolute left-1 top-1 inline-flex items-center gap-1 rounded-[4px] bg-studio-panel/90 px-1.5 text-[11px] text-studio-warning">
            <AlertTriangle aria-hidden className="size-3" />
            Older source
          </span>
        )}
      </button>
      <div className="flex items-center gap-1">
        <span dir="auto" className="min-w-0 flex-1 truncate text-small font-medium" title={panel.label}>
          {panel.label}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onRegenerate}
          disabled={busy || live || panel.status === 'waiting'}
          aria-label={`Regenerate ${panel.label}`}
          title="Regenerate"
        >
          <RefreshCw aria-hidden />
        </Button>
      </div>
      <StatusPill className="self-start" status={panelStatus(panel)} />
    </li>
  )
}

function PanelGrid({ character, sheet }: { character: Character; sheet: CharacterSheet }) {
  const { regenerate } = useSheetActions(character.id)
  const [open, setOpen] = useState<string | null>(null)
  const sections = useMemo(() => {
    const out: { key: string; title: string; panels: SheetPanel[] }[] = []
    for (const p of sheet.panels) {
      const s = out.find((x) => x.key === p.section)
      if (s) s.panels.push(p)
      else out.push({ key: p.section, title: p.section_title, panels: [p] })
    }
    return out
  }, [sheet.panels])
  const opened = sheet.panels.find((p) => p.key === open)

  if (!sheet.panels.length) {
    return (
      <EmptyState icon={<LayoutGrid />} title="No panels yet">
        Pick a preset above and press Make sheet. The full body comes first; the turnaround follows from it.
      </EmptyState>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      {regenerate.isError && <ErrorState compact title="Couldn't regenerate the panel" error={regenerate.error} />}
      {sections.map((s) => (
        <section key={s.key} aria-label={s.title}>
          <h3 dir="auto" className="section-label mb-2">
            {s.title} <span className="font-normal text-studio-muted">· {s.panels.length}</span>
          </h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3">
            {s.panels.map((p) => (
              <PanelTile
                key={p.key}
                panel={p}
                busy={regenerate.isPending}
                onOpen={() => setOpen(p.key)}
                onRegenerate={() =>
                  regenerate.mutate({ key: p.key }, { onSuccess: (g) => announce(`${p.label}: version ${g.version} queued.`) })
                }
              />
            ))}
          </ul>
        </section>
      ))}
      {opened && <PanelDialog character={character} panel={opened} onClose={() => setOpen(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------- the board

function BoardText({ character, sheet }: { character: Character; sheet: CharacterSheet }) {
  const uid = useId()
  const { patch } = useSheetActions(character.id)
  const sections = [...new Map(sheet.panels.map((p) => [p.section, p])).values()]
  const [titles, setTitles] = useState<Record<string, string>>(sheet.titles)
  const [team, setTeam] = useState(sheet.footer.team ?? '')
  const [number, setNumber] = useState(sheet.footer.number ?? '')
  const [ruler, setRuler] = useState(sheet.ruler)
  return (
    <details className="rounded-[6px] border border-studio-border bg-studio-raised p-3">
      <summary className="cursor-pointer text-body font-medium">Board text, in any language</summary>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          const all = Object.fromEntries(sections.map((p) => [p.section, (titles[p.section] ?? '').trim()]))
          patch.mutate({ titles: all, footer: { team: team.trim(), number: number.trim() }, ruler }, {
            onSuccess: () => announce('Board text saved. The board is being redrawn.'),
          })
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {sections.map((p) => (
            <div key={p.section} className="flex flex-col gap-1">
              <Label htmlFor={`${uid}-t-${p.section}`}>Section title: {p.section}</Label>
              <Input
                id={`${uid}-t-${p.section}`}
                dir="auto"
                maxLength={80}
                value={titles[p.section] ?? ''}
                placeholder={p.section_title}
                onChange={(e) => setTitles((t) => ({ ...t, [p.section]: e.target.value }))}
              />
              <AerabButton text={titles[p.section] ?? ''} onText={(v) => setTitles((t) => ({ ...t, [p.section]: v }))} target={`the ${p.section} title`} showNote={false} />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${uid}-team`}>Footer: team or unit</Label>
            <Input id={`${uid}-team`} dir="auto" maxLength={80} value={team} placeholder="Reef Unit" onChange={(e) => setTeam(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${uid}-num`}>Footer: sheet number</Label>
            <Input id={`${uid}-num`} dir="auto" maxLength={80} value={number} placeholder="Character sheet 01" onChange={(e) => setNumber(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={ruler} onChange={(e) => setRuler(e.target.checked)} className="size-4 accent-studio-accent" />
          Draw a height ruler beside the turnaround (uses the profile height)
        </label>
        {patch.isError && <ErrorState compact title="Couldn't save the board text" error={patch.error} />}
        <Button type="submit" variant="secondary" className="self-start" loading={patch.isPending}>
          Save board text
        </Button>
      </form>
    </details>
  )
}

function Board({ character, sheet }: { character: Character; sheet: CharacterSheet }) {
  const uid = useId()
  const { board } = useSheetActions(character.id)
  const [layout, setLayout] = useState<BoardLayout>(sheet.board.layout)
  const g = sheet.board.generation
  const working = sheet.board.status === 'queued' || sheet.board.status === 'running' || board.isPending
  const anyReady = sheet.panels.some((p) => p.current)
  return (
    <section aria-labelledby={`${uid}-h`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id={`${uid}-h`} className="flex-1 font-display text-panel font-semibold">
          Board
        </h3>
        <span id={`${uid}-layout`} className="sr-only">
          Board layout
        </span>
        <ToggleGroup type="single" value={layout} onValueChange={(v) => v && setLayout(v as BoardLayout)} aria-labelledby={`${uid}-layout`}>
          <ToggleGroupItem value="dossier">Dossier</ToggleGroupItem>
          <ToggleGroupItem value="studio">Studio</ToggleGroupItem>
        </ToggleGroup>
        <Button
          variant="secondary"
          onClick={() => board.mutate(layout, { onSuccess: () => announce('Laying out the board.') })}
          disabled={!anyReady || working}
        >
          {working ? <Loader2 aria-hidden className="animate-spin" /> : <LayoutGrid aria-hidden />}
          {g ? 'Redraw board' : 'Make board'}
        </Button>
      </div>
      <p className="text-small text-studio-muted">
        Dossier is dark, Studio is light. They're export styles for the sheet only. The board redraws itself when panels change, and
        it's saved in your Library.
      </p>
      {board.isError && <ErrorState compact title="Couldn't lay out the board" error={board.error} />}
      {g?.media_url ? (
        <figure className="flex flex-col gap-2">
          <a href={g.media_url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[6px] border border-studio-border-strong">
            <img src={g.thumb_url ?? g.media_url} alt={`Character sheet board of ${character.name}`} className="w-full" />
          </a>
          <figcaption className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={api.characters.boardUrl(character.id, 'png')} download>
                <Download aria-hidden />
                Download PNG
              </a>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <a href={api.characters.boardUrl(character.id, 'pdf')} download>
                <FileDown aria-hidden />
                Download PDF
              </a>
            </Button>
            {working && <span className="self-center text-small text-studio-muted" role="status">Redrawing…</span>}
          </figcaption>
        </figure>
      ) : (
        <p className="rounded-[6px] border border-dashed border-studio-border-strong p-4 text-small text-studio-muted" role="status">
          {working ? 'Laying out the board…' : 'The board appears once panels are finished.'}
        </p>
      )}
      {sheet.palette.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="section-label">Palette</span>
          <ul className="flex gap-1" aria-label="Palette from the full body">
            {sheet.palette.map((c) => (
              <li key={c} title={c} className="size-6 rounded-[4px] border border-studio-border" style={{ background: c }}>
                <span className="sr-only">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sheet.panels.length > 0 && <BoardText key={JSON.stringify([sheet.titles, sheet.footer, sheet.ruler])} character={character} sheet={sheet} />}
    </section>
  )
}

export function SheetTab({ character }: { character: Character }) {
  const sheet = useCharacterSheet(character.id)
  const cat = useSheetCatalogue()
  if (sheet.isPending || cat.isPending) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Loading the sheet">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (sheet.isError) return <ErrorState error={sheet.error} onRetry={() => sheet.refetch()} />
  if (cat.isError) return <ErrorState error={cat.error} onRetry={() => cat.refetch()} />
  const s = sheet.data
  const making = s.panels.filter((p) => ['queued', 'generating', 'waiting'].includes(p.status)).length
  return (
    <div className="flex flex-col gap-6">
      <SheetBuilder key={s.preset ?? 'new'} character={character} sheet={s} cat={cat.data} />
      {making > 0 && (
        <p role="status" className={cn('text-small text-studio-muted')}>
          {plural(making, 'panel')} still to make · about {minutes(s.estimate.seconds_low)}–{minutes(s.estimate.seconds_high)} min left
        </p>
      )}
      <PanelGrid character={character} sheet={s} />
      <Board character={character} sheet={s} />
    </div>
  )
}
