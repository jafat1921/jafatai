import { Download, Film } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AUDIO_DOWNLOADS, audioDownloadUrl } from '@/lib/audio-download'

/** "Download as" rows for a menu that's already open (the tile's ⋯ menu). */
export function AudioDownloadItems({ mediaId, version }: { mediaId: string; version?: string | null }) {
  return (
    <>
      <DropdownMenuLabel>Download as</DropdownMenuLabel>
      {AUDIO_DOWNLOADS.map((d) => (
        <DropdownMenuItem key={d.format} asChild>
          <a href={audioDownloadUrl(mediaId, d.format, version)} download>
            {d.format === 'mp4' ? <Film aria-hidden /> : <Download aria-hidden />}
            <span className="flex-1">{d.label}</span>
            <span className="text-[11px] text-studio-muted">{d.hint}</span>
          </a>
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** A Download button with the format choice, for the lightbox and players. */
export function AudioDownloadButton({ mediaId, version, size = 'sm' }: { mediaId: string; version?: string | null; size?: 'sm' | 'md' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size={size} variant="ghost">
          <Download aria-hidden />
          Download
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <AudioDownloadItems mediaId={mediaId} version={version} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
