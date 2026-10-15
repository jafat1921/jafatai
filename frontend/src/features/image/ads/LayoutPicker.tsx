import { useId } from 'react'
import { STYLES, type AdStyle } from '@/lib/ads'
import { cn } from '@/lib/utils'
import { useRoving } from './useRoving'

// Schematics on a 40 × 50 card (4:5). Photo areas are hatched, copy is bars, the accent is the theme's.
const W = 40
const H = 50

type Draw = (hatch: string) => React.ReactNode

const bar = (x: number, y: number, w: number, h = 2.4, cls = 'fill-current opacity-70') => <rect x={x} y={y} width={w} height={h} rx={h / 2} className={cls} />
const photo = (hatch: string, x = 0, y = 0, w = W, h = H) => <rect x={x} y={y} width={w} height={h} fill={`url(#${hatch})`} />
const accent = 'fill-studio-accent'
const paper = 'fill-studio-panel'

const SCHEMES: Record<AdStyle, Draw> = {
  frosted: (h) => (
    <>
      {photo(h)}
      <rect x={4} y={5} width={21} height={20} rx={2} className={paper} opacity={0.88} />
      {bar(7, 9, 15, 3.2)}
      {bar(7, 14, 12)}
      {bar(7, 19, 9, 3, accent)}
    </>
  ),
  side_wash: (h) => (
    <>
      {photo(h)}
      <rect x={0} y={0} width={22} height={H} className={paper} opacity={0.78} />
      {bar(4, 12, 14, 3.2)}
      {bar(4, 18, 11)}
      {bar(4, 24, 8, 3, accent)}
    </>
  ),
  bottom_bar: (h) => (
    <>
      {photo(h, 0, 0, W, 34)}
      <rect x={0} y={34} width={W} height={16} className="fill-current" opacity={0.85} />
      {bar(5, 38, 22, 3, 'fill-studio-panel')}
      {bar(5, 44, 14, 2.2, 'fill-studio-panel opacity-80')}
    </>
  ),
  split: (h) => (
    <>
      {photo(h, 18, 0, 22, H)}
      <path d={`M0 0 H20 Q16 25 20 ${H} H0 Z`} className={accent} opacity={0.85} />
      {bar(3, 16, 12, 3, 'fill-studio-panel')}
      {bar(3, 22, 9, 2.2, 'fill-studio-panel opacity-80')}
      <rect x={19} y={10} width={0.8} height={30} className="fill-current" opacity={0.6} />
    </>
  ),
  badge: (h) => (
    <>
      {photo(h)}
      {bar(4, 6, 18, 3.2)}
      {bar(4, 11, 12)}
      <circle cx={30} cy={34} r={7} className={accent} />
      {bar(26, 32.5, 8, 3, 'fill-studio-panel')}
    </>
  ),
  minimal: (h) => (
    <>
      {photo(h)}
      {bar(9, 8, 22, 3.2)}
      {bar(13, 13, 14)}
    </>
  ),
  cutout_blob: () => (
    <>
      <path d="M17 44 C8 42 9 30 15 25 C20 20 30 19 34 26 C38 33 35 45 26 46 C22 46.5 20 45 17 44 Z" className={accent} opacity={0.8} />
      <circle cx={10} cy={28} r={1.1} className={accent} />
      <circle cx={36} cy={19} r={1.4} className={accent} />
      <circle cx={33} cy={14} r={0.8} className={accent} />
      <circle cx={25} cy={23} r={4} className="fill-current" opacity={0.55} />
      <path d="M17 46 C17 33 33 33 33 46 Z" className="fill-current" opacity={0.55} />
      {bar(16, 3, 8, 2, 'fill-current opacity-50')}
      {bar(3, 9, 15, 3.2)}
      {bar(3, 14, 10)}
      <rect x={0} y={46} width={W} height={4} className="fill-current" opacity={0.75} />
    </>
  ),
  arch_mask: (h) => (
    <>
      {bar(8, 4, 24, 3.2)}
      {bar(12, 9, 16)}
      <path d="M8 44 V25 A12 12 0 0 1 32 25 V44 Z" fill={`url(#${h})`} className="stroke-current" strokeWidth={0.6} strokeOpacity={0.5} />
      <circle cx={32} cy={38} r={5} fill={`url(#${h})`} className="stroke-current" strokeWidth={0.6} />
      <circle cx={10} cy={22} r={4} className={accent} />
      {bar(3, 46.5, 7, 2, 'fill-current opacity-60')}
      {bar(22, 46.5, 15, 1.6, 'fill-current opacity-40')}
    </>
  ),
  circle_mask: (h) => (
    <>
      {bar(8, 4, 24, 3.2)}
      {bar(12, 9, 16)}
      <circle cx={20} cy={29} r={13} fill={`url(#${h})`} className="stroke-current" strokeWidth={0.6} strokeOpacity={0.5} />
      <circle cx={32} cy={39} r={5} fill={`url(#${h})`} className="stroke-current" strokeWidth={0.6} />
      <circle cx={8} cy={22} r={4} className={accent} />
      {bar(3, 46.5, 7, 2, 'fill-current opacity-60')}
      {bar(22, 46.5, 15, 1.6, 'fill-current opacity-40')}
    </>
  ),
  big_price: (h) => (
    <>
      {photo(h)}
      <rect x={0} y={0} width={24} height={H} className={paper} opacity={0.7} />
      {bar(3, 5, 19, 5)}
      {bar(3, 12, 14, 5)}
      <rect x={3} y={21} width={20} height={11} rx={1.5} className={accent} />
      <rect x={5} y={23} width={9} height={7} rx={1} className="fill-studio-panel" />
      {bar(15.5, 25.5, 6, 1.8, 'fill-studio-panel opacity-80')}
      {bar(3, 35, 13, 1.8)}
      {bar(3, 39, 10, 3, accent)}
      <rect x={0} y={45} width={W} height={5} className={paper} />
    </>
  ),
  editorial: (h) => (
    <>
      {bar(3, 5, 34, 6)}
      {bar(3, 13, 28, 6)}
      {bar(3, 21, 18, 6)}
      {bar(3, 31, 12, 1.8, 'fill-current opacity-50')}
      {bar(3, 35, 10, 1.8, 'fill-current opacity-50')}
      <rect x={22} y={31} width={15} height={15} rx={3} fill={`url(#${h})`} className="stroke-current" strokeWidth={0.6} strokeOpacity={0.5} />
    </>
  ),
  before_after: (h) => (
    <>
      {photo(h, 0, 0, 19.5, H)}
      {photo(h, 20.5, 0, 19.5, H)}
      <rect x={0} y={0} width={19.5} height={H} className="fill-current" opacity={0.18} />
      <rect x={19.5} y={0} width={1} height={H} className="fill-studio-panel" />
      <rect x={3} y={4} width={12} height={4} rx={2} className={paper} />
      <rect x={24} y={4} width={12} height={4} rx={2} className={accent} />
      {bar(5, 41, 30, 3.2)}
    </>
  ),
  quote: () => (
    <>
      <path d="M5 16 q0 -7 6 -8 v2.5 q-3 1 -3 3.5 h3 v6 h-6 z M14 16 q0 -7 6 -8 v2.5 q-3 1 -3 3.5 h3 v6 h-6 z" className={accent} />
      {bar(5, 24, 30, 3.2)}
      {bar(5, 29.5, 27, 3.2)}
      {bar(5, 35, 18, 3.2)}
      <rect x={5} y={42} width={4} height={0.8} className="fill-current" opacity={0.6} />
      {bar(11, 41.4, 12, 1.8, 'fill-current opacity-50')}
    </>
  ),
}

function Schematic({ style, uid }: { style: AdStyle; uid: string }) {
  const hatch = `${uid}-${style}-h`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden focusable="false" className="block h-auto w-full text-studio-text">
      <defs>
        <pattern id={hatch} width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={3} height={3} className="fill-current" opacity={0.12} />
          <rect width={0.9} height={3} className="fill-current" opacity={0.35} />
        </pattern>
      </defs>
      <rect x={0} y={0} width={W} height={H} className="fill-studio-raised" />
      {SCHEMES[style]?.(hatch)}
      <rect x={0.25} y={0.25} width={W - 0.5} height={H - 0.5} rx={1.5} fill="none" className="stroke-current" strokeOpacity={0.35} strokeWidth={0.5} />
    </svg>
  )
}

/** All the ad layouts as a radiogroup of little drawings. `needs` (from /ads/options) overrides the built-in hints. */
export function LayoutPicker({
  value,
  onChange,
  label = 'Layout',
  needs,
  compact,
  disabled,
}: {
  value: AdStyle
  onChange: (v: AdStyle) => void
  label?: string
  needs?: Partial<Record<AdStyle, string | null>>
  compact?: boolean
  disabled?: boolean
}) {
  const uid = useId().replace(/:/g, '')
  const ids = STYLES.map((s) => s.id)
  const { box, tabStop, onKeyDown } = useRoving(ids, value, onChange)
  return (
    <div
      ref={box}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn('grid gap-1.5', compact ? 'grid-cols-5 sm:grid-cols-7' : 'grid-cols-3 sm:grid-cols-4')}
    >
      {STYLES.map((s, i) => {
        const on = s.id === value
        const hint = needs && s.id in needs ? needs[s.id] : s.needs
        const hintId = hint ? `${uid}-${s.id}-n` : undefined
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={s.label}
            aria-describedby={hintId}
            disabled={disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => onChange(s.id)}
            onKeyDown={(e) => onKeyDown(i, e)}
            title={compact ? s.label : undefined}
            className={cn(
              'flex flex-col items-stretch gap-1 rounded-[6px] border p-1 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-studio-accent disabled:opacity-50',
              on ? 'border-studio-accent bg-studio-accent-soft ring-1 ring-studio-accent' : 'border-studio-border-strong bg-studio-panel hover:border-studio-border-hover hover:bg-studio-panel-hover',
            )}
          >
            <Schematic style={s.id} uid={uid} />
            {!compact && <span className="text-[12px] font-medium leading-tight text-studio-text">{s.label}</span>}
            {hint && (
              <span id={hintId} className={cn('leading-tight text-studio-muted', compact ? 'sr-only' : 'text-[11px]')}>
                {hint}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
