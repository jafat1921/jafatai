import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/** A switch with a title and a one-line explanation; the whole card is the click target. */
export function SwitchRow(props: {
  id: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  icon?: React.ReactNode
  title: string
  hint: React.ReactNode
  className?: string
}) {
  return (
    <label
      htmlFor={props.id}
      className={cn(
        'flex items-start gap-2.5 rounded-[6px] border border-studio-border-strong bg-studio-raised p-2.5',
        props.disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
        props.className,
      )}
    >
      <Switch
        id={props.id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
        aria-describedby={`${props.id}-hint`}
        className="mt-0.5"
      />
      <span>
        <span className="flex items-center gap-1 text-body font-medium">
          {props.icon} {props.title}
        </span>
        <span id={`${props.id}-hint`} className="block text-small text-studio-muted">
          {props.hint}
        </span>
      </span>
    </label>
  )
}
