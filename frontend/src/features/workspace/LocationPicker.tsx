import { fieldClass } from '@/components/ui/input'
import { useLocations } from '@/hooks/useLocations'
import { cn } from '@/lib/utils'
import { useProjectId } from './selection'

// Native select: keyboard and screen readers get the platform behaviour for free.
export function LocationPicker({
  id,
  value,
  onChange,
  label = 'Location',
  compact,
}: {
  id: string
  value: string | null
  onChange: (id: string | null) => void
  label?: string
  compact?: boolean
}) {
  const { data, isPending } = useLocations(useProjectId())
  const list = data ?? []
  return (
    <div className={cn('flex flex-col gap-1', compact && 'gap-0.5')}>
      <label htmlFor={id} className="section-label">
        {label}
      </label>
      <select
        id={id}
        className={cn(fieldClass, compact ? 'h-7 text-small' : 'h-8')}
        value={value ?? ''}
        disabled={isPending}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{list.length ? 'No location' : 'No locations yet (add in Cast & World)'}</option>
        {list.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
            {l.approved_establishing ? '' : ' (no frame yet)'}
          </option>
        ))}
        {/* a deleted location can linger on a scene until the refetch lands */}
        {value && !list.some((l) => l.id === value) && <option value={value}>Unknown location</option>}
      </select>
    </div>
  )
}
