import { Plug } from 'lucide-react'
import { useMe } from '@/hooks/useAuth'
import { Chip } from './chip'

/** Admin only (contract v34): swap a list over to the things made through the API, which the studio hides. */
export function ApiMadeChip({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const { data: me } = useMe()
  if (!me?.admin) return null
  return (
    <Chip selected={on} onClick={() => onChange(!on)} icon={<Plug aria-hidden />} title="Show only what API clients and scripts made; the studio leaves these out">
      Made through the API
    </Chip>
  )
}
