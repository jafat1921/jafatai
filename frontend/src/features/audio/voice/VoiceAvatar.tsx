import { initialOf } from '@/lib/voice'
import type { Voice } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The voice's portrait, or its initial on a tinted disc; decorative, the name is always beside it. */
export function VoiceAvatar({ voice, className }: { voice: Pick<Voice, 'name' | 'portrait_url' | 'kind'> | null | undefined; className?: string }) {
  if (voice?.portrait_url) return <img src={voice.portrait_url} alt="" className={cn('size-7 shrink-0 rounded-full object-cover ring-1 ring-studio-border-strong', className)} />
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full border font-display text-[13px] font-semibold',
        voice?.kind === 'design' ? 'border-studio-gold/50 bg-studio-gold/15 text-studio-text' : 'border-studio-border-strong bg-studio-accent-soft text-studio-accent-hover',
        className,
      )}
    >
      {voice ? initialOf(voice.name) : '·'}
    </span>
  )
}
