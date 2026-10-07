import { AlertTriangle, Check, CircleHelp, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { logoCheckOf } from '@/lib/brand'
import type { Generation } from '@/lib/types'

/** The vision check's verdict on a keyframe that should show the logo: icon plus words, never colour alone. */
export function LogoCheckBadge({ frame, onRegenerate, busy }: { frame: Generation; onRegenerate?: (issues: string[]) => void; busy?: boolean }) {
  const view = logoCheckOf(frame)
  if (!view) return null

  if (view.state === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 text-small text-studio-success">
        <Check aria-hidden className="size-3.5" />
        Logo OK
      </span>
    )
  }
  if (view.state === 'unchecked') {
    return (
      <Tooltip content={view.reason}>
        <span tabIndex={0} className="inline-flex items-center gap-1 text-small text-studio-muted" aria-label={`Logo not checked: ${view.reason}`}>
          <CircleHelp aria-hidden className="size-3.5" />
          Logo not checked
        </span>
      </Tooltip>
    )
  }
  return (
    <div className="flex flex-col gap-1 rounded-[6px] border border-studio-warning/40 bg-studio-warning/5 p-1.5">
      <span className="inline-flex items-center gap-1 text-small font-medium text-studio-warning">
        <AlertTriangle aria-hidden className="size-3.5" />
        Logo issues
      </span>
      <ul className="list-disc pl-5 text-small text-studio-muted" aria-label="Logo issues">
        {view.issues.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      {onRegenerate && (
        <Button type="button" size="sm" variant="secondary" className="self-start" loading={busy} onClick={() => onRegenerate(view.issues)}>
          <RefreshCcw aria-hidden />
          Regenerate with logo
        </Button>
      )}
    </div>
  )
}
