import { Keyboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip } from '@/components/ui/tooltip'

export type Shortcut = [keys: string[], description: string]

const REVIEW: Shortcut = [['A', 'R', 'X', 'V'], 'approve, regenerate, reject, versions']
const IMAGE: Shortcut = [['U', '+', '−', '0'], 'upscale, zoom in, zoom out, reset zoom (images)']

// No global "?" overlay yet, so each stage lists its keys in a header tooltip.
// TODO: fold these into a real "?" shortcuts sheet once more stages have keys of their own
export function ShortcutHelp({ shortcuts }: { shortcuts: Shortcut[] }) {
  const all = [...shortcuts, REVIEW, IMAGE]
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1 py-0.5">
          {all.map(([keys, desc]) => (
            <span key={desc} className="flex items-center gap-1">
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
              <span className="ml-1">{desc}</span>
            </span>
          ))}
          <span className="text-studio-muted">Ignored while typing in a field.</span>
        </span>
      }
    >
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Keyboard shortcuts: ${all.map(([k, d]) => `${k.join(' ')} ${d}`).join('; ')}`}
      >
        <Keyboard aria-hidden />
      </Button>
    </Tooltip>
  )
}
