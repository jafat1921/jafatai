import { Link } from 'react-router'
import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/studio/states'

export function NotFound() {
  return (
    <main className="flex h-full items-center justify-center">
      <EmptyState
        icon={<Compass />}
        title="Nothing at this address"
        action={
          <Button asChild variant="primary">
            <Link to="/projects">Go to projects</Link>
          </Button>
        }
      >
        The page may have moved, or the project was deleted.
      </EmptyState>
    </main>
  )
}
