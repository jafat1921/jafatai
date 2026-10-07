import { act, createEvent, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageEditPage } from '@/features/image/ImageEditPage'
import { ImageGeneratePage } from '@/features/image/ImageGeneratePage'
import { Img2ImgPage } from '@/features/image/Img2ImgPage'
import { QuickCreatePage } from '@/features/quick/QuickCreatePage'
import { Img2VidPage } from '@/features/video/Img2VidPage'
import { VideoCreatePage } from '@/features/video/VideoCreatePage'
import { fakeXhr, file } from '@/test/brand-fixtures'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { seedCatalog } from '@/test/model-fixtures'

afterEach(() => vi.unstubAllGlobals())

function api() {
  return mockApi((_m, path) => {
    if (path === '/media') return { items: [] }
    if (path === '/estimate' || path === '/system/upscale-options') return new Response('', { status: 404 })
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id, { title: 'Pasted still' }), versions: [] }
  })
}

const pasteImage = () => {
  const ev = createEvent.paste(document.body)
  Object.defineProperty(ev, 'clipboardData', { value: { files: [file('still.png', 'image/png')], items: [] } })
  fireEvent(document.body, ev)
}

const targets = async () => {
  const dialog = await screen.findByRole('dialog', { name: 'Use this picture as…' })
  return within(within(dialog).getByRole('group', { name: 'Use as' }))
    .getAllByRole('button')
    .map((b) => b.querySelector('.font-medium')?.textContent)
}

const PAGES: [string, React.ReactElement, string[]][] = [
  ['/image/generate', <ImageGeneratePage />, ['Edit source', 'Image to Image source']],
  ['/image/edit', <ImageEditPage />, ['Reference', 'Image to Image source']],
  ['/image/img2img', <Img2ImgPage />, ['Image to Image source', 'Edit source']],
  ['/video/create', <VideoCreatePage />, ['Start frame']],
  ['/video/img2vid', <Img2VidPage />, ['Start frame', 'End frame']],
  ['/video/quick', <QuickCreatePage />, ['Start frame', 'Edit source']],
]

describe('drop and paste anywhere', () => {
  it.each(PAGES)('%s offers only the targets that page can use', async (path, element, expected) => {
    api()
    renderAt(path, [{ path, element }], seedCatalog)
    pasteImage()
    expect(await targets()).toEqual(expected)
  })

  it('uploads the pasted picture and puts it where it was asked to go', async () => {
    api()
    fakeXhr(() => ({ status: 201, body: media('up1', { title: 'Pasted still', origin: 'upload' }) }))
    renderAt('/video/img2vid', [{ path: '/video/img2vid', element: <Img2VidPage /> }], seedCatalog)
    const user = userEvent.setup()
    pasteImage()
    await screen.findByRole('dialog', { name: 'Use this picture as…' })
    await user.click(screen.getByRole('button', { name: /End frame/ }))

    const dock = screen.getByRole('form', { name: 'Image to Video' })
    expect(await within(dock).findByRole('img', { name: 'Pasted still' })).toBeInTheDocument()
    expect(within(dock).getByRole('button', { name: 'Remove the end image' })).toBeInTheDocument()
    expect(within(dock).getByRole('button', { name: 'Add start image (required)' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a drop hint while a file is dragged over the page, then asks', async () => {
    api()
    renderAt('/image/edit', [{ path: '/image/edit', element: <ImageEditPage /> }], seedCatalog)
    const data = { types: ['Files'], files: [file('still.png', 'image/png')] }
    act(() => {
      window.dispatchEvent(Object.assign(new Event('dragenter', { bubbles: true }), { dataTransfer: data }))
    })
    expect(screen.getByText('Drop the picture anywhere')).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: data }))
    })
    expect(screen.queryByText('Drop the picture anywhere')).not.toBeInTheDocument()
    expect(await targets()).toEqual(['Reference', 'Image to Image source'])
  })
})
