import { useId } from 'react'
import { RadioGroup } from 'radix-ui'
import { AudioLines, Clock, Film, Images, Layers, Lock, MicVocal, Rotate3d, Type, VolumeX, type LucideIcon } from 'lucide-react'
import { ModelBadge } from '@/components/shell/MegaMenu'
import { capabilityLabels, secondsText, type CapabilityIcon } from '@/lib/models'
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

/** Radio cards: arrow keys move between models and skip the ones that can't be used. */
export function ModelPicker({ label, models, value, onChange, blockedBy, highlighted, className }: Props) {
  const uid = useId()
  return (
    <div className={className}>
      <div id={`${uid}-label`} className="section-label mb-2">
        {label}
      </div>
      <RadioGroup.Root
        aria-labelledby={`${uid}-label`}
        value={value ?? ''}
        onValueChange={onChange}
        className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(220px,1fr))]"
      >
        {models.map((m) => {
          const reason = m.available ? (blockedBy?.(m) ?? null) : (m.reason || 'Not installed on the server yet.')
          const est = m.est_seconds ? `about ${secondsText(m.est_seconds)} each` : null
          const ids = `${uid}-${m.id}`
          const licence = m.extra?.licence
          return (
            <RadioGroup.Item
              key={m.id}
              value={m.id}
              disabled={!!reason}
              aria-label={m.badge ? `${m.label}, ${m.badge}` : m.label}
              aria-describedby={`${ids}-d ${ids}-c${licence ? ` ${ids}-l` : ''}${reason ? ` ${ids}-r` : ''}`}
              className={cn(
                'flex flex-col items-stretch gap-1.5 rounded-[6px] border p-2.5 text-left transition-colors duration-150',
                'border-studio-border-strong bg-studio-raised hover:bg-studio-panel-hover',
                'data-[state=checked]:border-studio-accent data-[state=checked]:bg-studio-accent-soft',
                'disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:bg-studio-raised',
                highlighted && value === m.id && 'ring-2 ring-studio-gold/70',
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center rounded-full border border-studio-border-strong bg-studio-panel"
                >
                  <RadioGroup.Indicator className="size-2 rounded-full bg-studio-accent" />
                </span>
                {/* licensed names (MiniMax-Music3) must show in full, so they wrap instead of truncating */}
                <span className={cn('min-w-0 flex-1 text-body font-medium text-studio-text', licence ? 'break-words' : 'truncate')}>{m.label}</span>
                {m.badge && <ModelBadge badge={m.badge} />}
              </span>
              <span id={`${ids}-d`} className="text-small text-studio-muted">
                {m.description}
                {est && !reason ? ` · ${est}` : ''}
              </span>
              <CapabilityChips model={m} id={`${ids}-c`} />
              {licence && (
                <span id={`${ids}-l`} className="text-[12px] leading-4 text-studio-muted">
                  {licence}
                </span>
              )}
              {reason && (
                <span id={`${ids}-r`} className="flex items-start gap-1 text-small text-studio-warning">
                  <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
                  {reason}
                </span>
              )}
            </RadioGroup.Item>
          )
        })}
      </RadioGroup.Root>
    </div>
  )
}
