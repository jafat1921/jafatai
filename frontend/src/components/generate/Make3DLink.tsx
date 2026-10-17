import { Link } from 'react-router'
import { Box } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFeature } from '@/hooks/useUsage'
import { make3dHref, type Start3DLink } from '@/lib/model3d'

interface Props {
  start: Start3DLink
  label?: string
  // for screen readers when the visible label alone doesn't say what is turned into 3D
  ariaLabel?: string
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'secondary'
  // from a form with unsaved work (an ad brief, a brand kit), so leaving doesn't lose it
  newTab?: boolean
  onClick?: () => void
  className?: string
}

/** "Make 3D": opens the 3D Studio prefilled. Hidden when the package has no 3D Studio. */
export function Make3DLink({ start, label = 'Make 3D', ariaLabel, size = 'sm', variant = 'ghost', newTab, onClick, className }: Props) {
  const on = useFeature('3d')
  if (!on) return null
  const name = ariaLabel ?? label
  return (
    <Button asChild size={size} variant={variant} className={className}>
      <Link
        to={make3dHref(start)}
        onClick={onClick}
        aria-label={newTab ? `${name} (opens in a new tab)` : ariaLabel}
        target={newTab ? '_blank' : undefined}
        rel={newTab ? 'noopener' : undefined}
      >
        <Box aria-hidden />
        {label}
      </Link>
    </Button>
  )
}
