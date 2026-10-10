import { api } from '@/lib/api'
import type { AudioExportFormat } from '@/lib/types'

// the master is FLAC; most people want an MP3 they can send, so it leads
export const AUDIO_DOWNLOADS: { format: AudioExportFormat; label: string; hint: string }[] = [
  { format: 'mp3_320', label: 'MP3', hint: '320 kbps · plays everywhere' },
  { format: 'wav16', label: 'WAV', hint: '16-bit · for editing' },
  { format: 'wav24', label: 'WAV 24-bit', hint: 'studio quality' },
  { format: 'flac', label: 'FLAC', hint: 'lossless, smaller than WAV' },
  { format: 'mp4', label: 'MP4 video', hint: 'waveform video to share' },
]

export const audioDownloadUrl = (mediaId: string, format: AudioExportFormat, version?: string | null) =>
  api.audio.exportUrl(mediaId, { format, ...(version ? { version } : {}) })
