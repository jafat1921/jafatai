import { useId } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MAX_PALETTE, MIN_PALETTE, normalizeHex, type PaletteColour } from '@/lib/brand'
import { EditorSection } from './EditorSection'

// a gentle start when the kit has none: ink, parchment, gold
const STARTERS = ['#1C140C', '#F4EAD5', '#B8862F']

function Swatch({ c, index, onChange, onRemove }: { c: PaletteColour; index: number; onChange: (c: PaletteColour) => void; onRemove: () => void }) {
  const uid = useId()
  const valid = normalizeHex(c.hex)
  const n = index + 1
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-[6px] border border-studio-border bg-studio-raised p-2">
      <input
        type="color"
        aria-label={`Colour ${n} picker`}
        value={(valid ?? '#000000').toLowerCase()}
        onChange={(e) => onChange({ ...c, hex: e.target.value.toUpperCase() })}
        className="size-8 shrink-0 cursor-pointer rounded-[4px] border border-studio-border-strong bg-transparent p-0.5"
      />
      <Input
        aria-label={`Colour ${n} hex`}
        value={c.hex}
        maxLength={7}
        spellCheck={false}
        aria-invalid={!valid || undefined}
        aria-describedby={valid ? undefined : `${uid}-err`}
        onChange={(e) => onChange({ ...c, hex: e.target.value })}
        onBlur={() => valid && valid !== c.hex && onChange({ ...c, hex: valid })}
        className="w-24 font-mono"
      />
      <Input
        aria-label={`Colour ${n} name`}
        value={c.name ?? ''}
        maxLength={60}
        onChange={(e) => onChange({ ...c, name: e.target.value })}
        placeholder="Name, e.g. deep teal"
        className="min-w-32 flex-1"
      />
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove colour ${n}`} onClick={onRemove}>
        <X aria-hidden />
      </Button>
      {!valid && (
        <p id={`${uid}-err`} role="alert" className="basis-full text-small text-studio-danger">
          Use a hex colour like #0F4C5C.
        </p>
      )}
    </li>
  )
}

export function PaletteSection({ palette, onChange }: { palette: PaletteColour[]; onChange: (p: PaletteColour[]) => void }) {
  const full = palette.length >= MAX_PALETTE
  return (
    <EditorSection
      title="Palette"
      hint={`${MIN_PALETTE} to ${MAX_PALETTE} colours. They go into every prompt by name and hex, and tint the optional colour grade.`}
      aside={
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={full}
          onClick={() => onChange([...palette, { hex: STARTERS[palette.length % STARTERS.length], name: '' }])}
        >
          <Plus aria-hidden />
          Add colour
        </Button>
      }
    >
      {palette.length > 0 ? (
        <ul className="grid gap-2 md:grid-cols-2" aria-label="Palette colours">
          {palette.map((c, i) => (
            <Swatch
              key={i}
              c={c}
              index={i}
              onChange={(next) => onChange(palette.map((x, j) => (j === i ? next : x)))}
              onRemove={() => onChange(palette.filter((_, j) => j !== i))}
            />
          ))}
        </ul>
      ) : (
        <p className="text-small text-studio-muted">No colours yet.</p>
      )}
      {palette.length > 0 && palette.length < MIN_PALETTE && (
        <p className="text-small text-studio-muted">Add {MIN_PALETTE - palette.length} more for a fuller look (optional).</p>
      )}
      {full && <p className="text-small text-studio-muted">{MAX_PALETTE} colours is the most that reads well in a prompt.</p>}
    </EditorSection>
  )
}
