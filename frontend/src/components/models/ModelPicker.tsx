import { useId } from 'react'
import { RadioGroup } from 'radix-ui'
import { AudioLines, Clock, Film, Images, Layers, Lock, MicVocal, Rotate3d, Type, VolumeX, type LucideIcon } from 'lucide-react'
import { ModelBadge } from '@/components/shell/MegaMenu'
import { capabilityLabels, modelSections, secondsText, type CapabilityIcon } from '@/lib/models'
import type { ModelInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

const ICONS: Record<CapabilityIcon, LucideIcon> = {
  sound: AudioLines,
  mute: VolumeX,
  text: Type,
  type: Type,
  refs: Layers,
  long: Clock,
  image: Images,
  frames: Film,
  angles: Rotate3d,
  vocals: MicVocal,
}

export function CapabilityChips({ model, id }: { model: ModelInfo; id?: string }) {
  const caps = capabilityLabels(model)
  if (!caps.length) return null
  return (
    <span id={id} className="flex flex-wrap gap-1">
      {caps.map((c) => {
        const Icon = ICONS[c.icon]
        return (
          <span key={c.text} className="inline-flex items-center gap-1 rounded-[4px] border border-studio-border px-1.5 text-[12px] leading-5 text-studio-muted">
            <Icon aria-hidden className="size-3" />
            {c.text}
          </span>
        )
      })}
    </span>
  )
}

function whyBlocked(m: ModelInfo, blockedBy?: (m: ModelInfo) => string | null): string | null {
  if (m.available) return blockedBy?.(m) ?? null
  if (m.installed === false) return m.reason ? `Not installed on the server (${m.reason})` : 'Not installed on the server yet.'
  return m.reason || 'Not installed on the server yet.'
}

interface Props {
  label: string
  models: ModelInfo[]
  value: string | undefined
  onChange: (id: string) => void
  // a reason this model can't be used right now (e.g. Wan with a start image); null when it can
  blockedBy?: (m: ModelInfo) => string | null
  highlighted?: boolean
  className?: string
}

/**
 * Radio cards: arrow keys move between models and skip the ones that can't be used. Image models come in
 * sections (Fast, Photoreal, Text & design, Anime & illustration, Experimental) inside one scroll area;
 * the section name is part of each card's description, since a radiogroup can't own headings.
 */
export function ModelPicker({ label, models, value, onChange, blockedBy, highlighted, className }: Props) {
  const uid = useId()
  const sections = modelSections(models)
  const grouped = sections.some((s) => s.label)
  return (
    <div className={className}>
      <div id={`${uid}-label`} className="section-label mb-2">
        {label}
      </div>
      <RadioGroup.Root
        aria-labelledby={`${uid}-label`}
        value={value ?? ''}
        onValueChange={onChange}
        className={cn(grouped && 'flex max-h-[min(62vh,34rem)] flex-col gap-3 overflow-y-auto overscroll-contain pr-1')}
      >
        {sections.map((sec) => (
          <div key={sec.id} className="flex flex-col gap-1.5">
            {sec.label && (
              <div id={`${uid}-g-${sec.id}`} aria-hidden className="sticky top-0 z-[1] bg-studio-panel py-0.5 text-[12px] font-medium uppercase tracking-wide text-studio-muted">
                {sec.label}
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
              {sec.models.map((m) => (
                <ModelCard
                  key={m.id}
                  m={m}
                  ids={`${uid}-${m.id}`}
                  groupId={sec.label ? `${uid}-g-${sec.id}` : null}
                  reason={whyBlocked(m, blockedBy)}
                  ring={!!highlighted && value === m.id}
                />
              ))}
            </div>
          </div>
        ))}
      </RadioGroup.Root>
    </div>
  )
}

function ModelCard({ m, ids, groupId, reason, ring }: { m: ModelInfo; ids: string; groupId: string | null; reason: string | null; ring: boolean }) {
  const est = m.est_seconds ? `about ${secondsText(m.est_seconds)} each${m.estimate_source === 'measured' ? '' : ' (est.)'}` : null
  const name = [m.label, m.badge].filter(Boolean).join(', ')
  const described = [`${ids}-d`, `${ids}-c`, reason && `${ids}-r`, groupId].filter(Boolean).join(' ')
  return (
    <RadioGroup.Item
      value={m.id}
      disabled={!!reason}
      aria-label={name}
      aria-describedby={described}
      className={cn(
        'flex flex-col items-stretch gap-1.5 rounded-[6px] border p-2.5 text-left transition-colors duration-150',
        'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
        'data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft',
        'disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-studio-raised',
        ring && 'ring-2 ring-studio-gold/70',
      )}
    >
      <span className="flex items-center gap-2">
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full border border-studio-border-strong bg-studio-panel">
          <RadioGroup.Indicator className="size-2 rounded-full bg-studio-accent" />
        </span>
        <span className="min-w-0 flex-1 truncate text-body font-medium text-studio-text">{m.label}</span>
        {m.badge && <ModelBadge badge={m.badge} />}
      </span>
      <span id={`${ids}-d`} className="text-small text-studio-muted">
        {m.description}
        {est && !reason ? ` · ${est}` : ''}
        {m.best_for?.length ? <span className="block">Best for {m.best_for.join(', ')}</span> : null}
      </span>
      <CapabilityChips model={m} id={`${ids}-c`} />
      {reason && (
        <span id={`${ids}-r`} className="flex items-start gap-1 text-small text-studio-warning">
          <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
          {reason}
        </span>
      )}
    </RadioGroup.Item>
  )
}
