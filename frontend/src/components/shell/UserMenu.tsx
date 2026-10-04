import { useNavigate } from 'react-router'
import { LogOut, Palette, User as UserIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLogout, useMe } from '@/hooks/useAuth'
import { useQuillCursor } from '@/lib/quill'

export function UserMenu() {
  const { data: me } = useMe()
  const logout = useLogout()
  const navigate = useNavigate()
  const [quill, setQuill] = useQuillCursor()
  const name = me?.display_name || me?.email || 'Account'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-2 rounded-[6px] py-1 pl-1 pr-2 hover:bg-studio-panel-hover"
        aria-label={`Account menu for ${name}`}
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-studio-raised text-studio-muted">
          <UserIcon aria-hidden className="size-3.5" />
        </span>
        <span className="hidden max-w-32 truncate text-body font-medium md:inline">{name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block text-body text-studio-text">{name}</span>
          {me && <span className="block text-small font-normal">{me.email} · {me.role}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={quill} onCheckedChange={(v) => setQuill(v === true)}>
          Quill cursor
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {import.meta.env.DEV && (
          <DropdownMenuItem onSelect={() => navigate('/dev/ui')}>
            <Palette aria-hidden />
            UI kit (dev)
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
        >
          <LogOut aria-hidden />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
