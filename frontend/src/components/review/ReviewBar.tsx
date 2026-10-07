import { Check, ChevronDown, History, ImageUpscale, Lock, RefreshCw, RotateCcw, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Progress } from '@/components/ui/progress'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusPill } from '@/components/studio/status-pill'
import { generationStatus } from '@/lib/status'
import type { GenerationStatus, RegenerateMode } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface ReviewBarProps {
  status: GenerationStatus
  version: number
  versionCount: number
  progress?: number | null
  error?: string | null
  versionsOpen?: boolean
  busy?: boolean
  onApprove: () => void
  onUnapprove: () => void
  onRegenerate: (mode: RegenerateMode) => void
  onReject: () => void
  onRestore: () => void
  onToggleVersions: () => void
  onCancel?: () => void
  // images only; hidden for videos and while nothing's finished
  onUpscale?: () => void
  className?: string
}

export function ReviewBar(props: ReviewBarProps) {
  const { status, version, versionCount, progress, error, versionsOpen, busy, className } = props

  if (status === 'queued' || status === 'generating') {
    const view = generationStatus(status, status === 'generating' ? (progress ?? undefined) : undefined)
    return (
      <div role="group" aria-label="Review" className={cn('flex flex-col gap-2', className)}>
        <div className="flex items-center gap-2">
          <StatusPill status={view} />
          <span className="font-mono text-small text-studio-muted">v{version}</span>
          {props.onCancel && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={props.onCancel}>
              <X aria-hidden />
              Cancel
            </Button>
          )}
        </div>
        <Progress value={status === 'generating' ? (progress ?? null) : null} label={view.label} />
      </div>
    )
  }

  const versionsButton = (
    <Button
      size="sm"
      variant="ghost"
      aria-expanded={versionsOpen}
      aria-label={`Versions, showing version ${version} of ${versionCount}`}
      onClick={props.onToggleVersions}
      title="Versions (V)"
    >
      <History aria-hidden />
      <span className="font-mono">
        v{version} of {versionCount}
      </span>
      <ChevronDown aria-hidden className={cn('transition-transform', versionsOpen && 'rotate-180')} />
    </Button>
  )

  return (
    <div role="group" aria-label="Review" className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {status === 'approved' && (
          <>
            <span className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-studio-success/60 bg-transparent px-2 text-small font-medium text-studio-success">
              <Check aria-hidden className="size-3.5" />
              Approved
              <Lock aria-hidden className="size-3" />
            </span>
            <Button size="sm" variant="ghost" onClick={props.onUnapprove} disabled={busy}>
              <Undo2 aria-hidden />
              Unapprove
            </Button>
          </>
        )}

        {status === 'ready' && (
          <Button size="sm" variant="primary" onClick={props.onApprove} disabled={busy} aria-keyshortcuts="A">
            <Check aria-hidden />
            Approve
            <Kbd>A</Kbd>
          </Button>
        )}

        {status === 'rejected' && (
          <>
            <StatusPill status={generationStatus('rejected')} />
            <Button size="sm" variant="secondary" onClick={props.onRestore} disabled={busy}>
              <RotateCcw aria-hidden />
              Restore
            </Button>
          </>
        )}

        {status === 'failed' && <StatusPill status={generationStatus('failed')} />}

        <RegenerateSplit
          label={status === 'failed' ? 'Retry' : 'Regenerate'}
          onRegenerate={props.onRegenerate}
          disabled={busy}
        />

        {status === 'ready' && (
          <Button size="sm" variant="ghost" onClick={props.onReject} disabled={busy} aria-keyshortcuts="X">
            <X aria-hidden />
            Reject
          </Button>
        )}

        {props.onUpscale && (status === 'ready' || status === 'approved') && (
          <Button size="sm" variant="ghost" onClick={props.onUpscale} disabled={busy} aria-keyshortcuts="U" title="Bigger, sharper copy as a new version (U)">
            <ImageUpscale aria-hidden />
            Upscale
            <Kbd>U</Kbd>
          </Button>
        )}

        <div className="ml-auto">{versionsButton}</div>
      </div>
      {status === 'failed' && error && <p className="text-small text-studio-danger">{error}</p>}
    </div>
  )
}

function RegenerateSplit({
  label,
  onRegenerate,
  disabled,
}: {
  label: string
  onRegenerate: (mode: RegenerateMode) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex">
      <Button
        size="sm"
        variant="secondary"
        className="rounded-r-none"
        onClick={() => onRegenerate('same')}
        disabled={disabled}
        aria-keyshortcuts="R"
        title="Same prompt, new seed (R)"
      >
        <RefreshCw aria-hidden />
        {label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="secondary"
            className="rounded-l-none border-l-0"
            aria-label="More regenerate options"
            disabled={disabled}
          >
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onRegenerate('same')}>
            Same prompt, new seed
            <DropdownMenuShortcut>R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onRegenerate('note')}>
            With note…
            <DropdownMenuShortcut>Shift+R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onRegenerate('edit')}>
            Edit &amp; regenerate…
            <DropdownMenuShortcut>E</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
