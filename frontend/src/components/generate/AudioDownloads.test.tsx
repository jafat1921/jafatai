import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AudioDownloadButton } from './AudioDownloads'

describe('audio downloads', () => {
  it('offers MP3, WAV, FLAC and an MP4 video of the same version', async () => {
    render(<AudioDownloadButton mediaId="m1" version="g7" />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download' }))
    const hrefs = screen.getAllByRole('menuitem').map((el) => el.getAttribute('href') ?? '')
    expect(hrefs.map((h) => new URL(h, 'http://x').searchParams.get('format'))).toEqual(['mp3_320', 'wav16', 'wav24', 'flac', 'mp4'])
    expect(hrefs[0]).toContain('/audio/m1/export?')
    expect(hrefs.every((h) => h.includes('version=g7'))).toBe(true)
    expect(screen.getByRole('menuitem', { name: /MP4 video/ })).toBeInTheDocument()
  })
})
