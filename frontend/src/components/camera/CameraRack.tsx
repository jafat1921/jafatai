import { useId, useRef } from 'react'
import { RotateCcw, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { DockChip } from '@/components/generate/DockChip'
import {
  ANGLES,
  cameraSummary,
  DEFAULT_SPEED,
  isEmptyCamera,
  motionTakesSpeed,
  MOTIONS,
  SHOT_SIZES,
  SPEEDS,
  type CameraPreset,
  type CameraSetting,
  type CameraSpeed,
} from '@/lib/camera'
import { cn } from '@/lib/utils'
import { AngleDiagram, MotionDiagram, SizeDiagram } from './CameraDiagram'

interface RowProps<T extends string> {
  label: string
  options: CameraPreset<T>[]
  value: T | undefined
  onChange: (v: T | undefined) => void
  art: (id: T) => React.ReactNode
}

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/** One radio row of chips. Arrows move and pick (the radio pattern); picking the chosen chip again clears it. */
function ChipRow<T extends string>({ label, options, value, onChange, art }: RowProps<T>) {
  const uid = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const at = options.findIndex((o) => o.id === value)
  const tabStop = at >= 0 ? at : 0

  const go = (i: number) => {
    const n = (i + options.length) % options.length
    refs.current[n]?.focus()
    onChange(options[n].id)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${uid}-label`} className="section-label">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${uid}-label`}
        className="flex flex-wrap gap-1"
        onKeyDown={(e) => {
          const i = refs.current.findIndex((el) => el === document.activeElement)
          if (i < 0) return
          // RTL pages flip left/right, like the rest of the dock
          const rtl = getComputedStyle(e.currentTarget).direction === 'rtl'
          let step = NEXT[e.key]
          if (step && rtl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) step = -step
          if (step) go(i + step)
          else if (e.key === 'Home') go(0)
          else if (e.key === 'End') go(options.length - 1)
          else return
          e.preventDefault()
        }}
      >
        {options.map((o, i) => {
          const on = o.id === value
          return (
            <Tooltip key={o.id} content={o.description}>
              <button
                ref={(el) => {
                  refs.current[i] = el
                }}
                type="button"
                role="radio"
                aria-checked={on}
                aria-describedby={`${uid}-d-${o.id}`}
                tabIndex={i === tabStop ? 0 : -1}
                onClick={() => onChange(on ? undefined : o.id)}
                className={cn(
                  'cam-chip inline-flex h-9 items-center gap-1.5 rounded-[6px] border pl-1 pr-2.5 text-small transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-studio-gold',
                  on
                    ? 'border-studio-accent bg-studio-accent-soft text-studio-text'
                    : 'border-studio-border-strong bg-studio-raised text-studio-text hover:bg-studio-panel-hover',
                )}
              >
                {art(o.id)}
                {o.label}
              </button>
            </Tooltip>
          )
        })}
      </div>
      {/* outside the chips, so the description isn't read as part of the name */}
      <div hidden>
        {options.map((o) => (
          <span key={o.id} id={`${uid}-d-${o.id}`}>
            {o.description}
          </span>
        ))}
      </div>
    </div>
  )
}

interface Props {
  value: CameraSetting
  onChange: (c: CameraSetting) => void
  className?: string
}

/** Shot size · Angle · Motion chips with looping diagrams, plus the speed of the move. */
export function CameraRack({ value, onChange, className }: Props) {
  const uid = useId()
  const set = (patch: Partial<CameraSetting>) => onChange({ ...value, ...patch })
  const canSpeed = motionTakesSpeed(value.motion)
  const summary = cameraSummary(value)

  return (
    <TooltipProvider delayDuration={500}>
      <div className={cn('flex flex-col gap-3', className)}>
        <ChipRow label="Shot size" options={SHOT_SIZES} value={value.size} onChange={(size) => set({ size })} art={(id) => <SizeDiagram size={id} />} />
        <ChipRow label="Angle" options={ANGLES} value={value.angle} onChange={(angle) => set({ angle })} art={(id) => <AngleDiagram angle={id} />} />
        <ChipRow label="Motion" options={MOTIONS} value={value.motion} onChange={(motion) => set({ motion })} art={(id) => <MotionDiagram motion={id} />} />
        <div className="flex flex-wrap items-center gap-2">
          <span id={`${uid}-speed`} className="section-label">
            Speed
          </span>
          <ToggleGroup
            type="single"
            aria-labelledby={`${uid}-speed`}
            value={canSpeed ? (value.speed ?? DEFAULT_SPEED) : ''}
            onValueChange={(v) => v && set({ speed: v as CameraSpeed })}
            disabled={!canSpeed}
            className={cn('h-8', !canSpeed && 'opacity-60')}
          >
            {SPEEDS.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id} className="h-6 px-3 text-small">
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {!canSpeed && <span className="text-small text-studio-muted">Pick a move to set its speed.</span>}
        </div>
        <div className="flex items-center gap-2 border-t border-studio-border pt-2">
          <p className="mr-auto text-small text-studio-muted" aria-live="polite">
            {summary ? (
              <>
                Camera: <span className="text-studio-text">{summary}</span>
              </>
            ) : (
              'No camera direction: the model decides.'
            )}
          </p>
          <Button type="button" size="sm" variant="ghost" disabled={isEmptyCamera(value)} onClick={() => onChange({})}>
            <RotateCcw aria-hidden />
            Reset
          </Button>
        </div>
      </div>
    </TooltipProvider>
  )
}

/** The dock chip: "Camera: MS · Low · Push-in slow ▾", the rack in its popover. */
export function CameraChip({ value, onChange }: Props) {
  const summary = cameraSummary(value)
  return (
    <DockChip name="Camera" value={summary || 'Any'} icon={<Video aria-hidden />} active={!!summary} wide>
      <CameraRack value={value} onChange={onChange} />
    </DockChip>
  )
}
