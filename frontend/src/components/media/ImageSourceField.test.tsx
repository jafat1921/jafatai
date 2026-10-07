import { useState } from 'react'
import { createEvent, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkBrandFile, brandUploadErrorText } from '@/lib/upload'
import { fakeXhr, file } from '@/test/brand-fixtures'
import { media, mockApi, renderAt } from '@/test/media-fixtures'
import { ImageSourceField } from './ImageSourceField'

afterEach(() => vi.unstubAllGlobals())

function Harness({ onChange, purpose }: { onChange: (id: string | null) => void; purpose?: 'logo' }) {
  const [id, setId] = useState<string | null>(null)
  return (
    <ImageSourceField
      label="Start image"
      required
      purpose={purpose}
      value={id}
      globalPaste
      onChange={(v) => {
        setId(v)
        onChange(v)
      }}
    />
  )
}

function setup(purpose?: 'logo') {
  mockApi((_m, path) => {
    if (path === '/media') return { items: [media('lib1', { title: 'Harbour at dawn' })] }
    const id = path.match(/^\/media\/(\w+)$/)?.[1]
    if (id) return { ...media(id), versions: [] }
  })
  const onChange = vi.fn()
  renderAt('/x', [{ path: '/x', element: <Harness onChange={onChange} purpose={purpose} /> }])
  return { onChange, user: userEvent.setup(), zone: () => screen.getByRole('group', { name: 'Add start image' }) }
}

const pasteFiles = (target: Element | Window, files: File[]) => {
  const ev = createEvent.paste(target)
  Object.defineProperty(ev, 'clipboardData', { value: { files, items: [] } })
  fireEvent(target, ev)
}

describe('ImageSourceField', () => {
  it('uploads a pasted image with progress, then shows it in the darkroom frame', async () => {
    const sent = fakeXhr(() => ({ status: 201, body: media('up1', { title: 'Pasted shot', origin: 'upload' }) }))
    const { onChange, zone } = setup()
    pasteFiles(zone(), [file('image.png', 'image/png')])

    expect(screen.getByRole('progressbar', { name: 'Uploading image.png' })).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: 'Pasted shot' })).toBeInTheDocument()
    expect(sent[0].url).toBe('/api/media/upload')
    expect(onChange).toHaveBeenLastCalledWith('up1')
  })

  it('takes a paste anywhere on the page, but not while typing in a text box', async () => {
    fakeXhr(() => ({ status: 201, body: media('up2', { title: 'From the page' }) }))
    const { onChange } = setup()
    const box = document.createElement('textarea')
    document.body.appendChild(box)
    pasteFiles(box, [file('a.png', 'image/png')])
    expect(onChange).not.toHaveBeenCalled()
    box.remove()

    pasteFiles(document.body, [file('b.png', 'image/png')])
    expect(await screen.findByRole('img', { name: 'From the page' })).toBeInTheDocument()
  })

  it('uploads a dropped file and explains a 413 in plain words', async () => {
    fakeXhr(() => ({ status: 413, body: { detail: 'Request Entity Too Large' } }))
    const { onChange, zone } = setup()
    fireEvent.drop(zone(), { dataTransfer: { files: [file('big.png', 'image/png')] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('“big.png” is too big for the server.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses the wrong type before uploading', () => {
    const sent = fakeXhr(() => ({ status: 201, body: {} }))
    const { zone } = setup()
    fireEvent.drop(zone(), { dataTransfer: { files: [file('notes.pdf', 'application/pdf')] } })
    expect(screen.getByRole('alert')).toHaveTextContent(/isn't a file type we can use/)
    expect(sent).toHaveLength(0)
  })

  it('picks from the Library, then replaces and removes', async () => {
    const { onChange, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Pick from Library' }))
    const dialog = screen.getByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: /Harbour at dawn/ }))
    await user.click(within(dialog).getByRole('button', { name: /Use selected/ }))
    expect(onChange).toHaveBeenLastCalledWith('lib1')
    expect(await screen.findByRole('img', { name: 'Harbour at dawn' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Replace' }))
    expect(screen.getByRole('group', { name: 'Add start image' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep the current image' }))
    await user.click(screen.getByRole('button', { name: 'Remove start image' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('opens the file browser from the keyboard', async () => {
    const { user, zone } = setup()
    const input = screen.getByTestId('source-input') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    zone().focus()
    await user.keyboard('{Enter}')
    expect(click).toHaveBeenCalled()
  })

  it('sends logos to the brand endpoint and shows the server warning', async () => {
    const sent = fakeXhr(() => ({ status: 201, body: { item: media('lg1', { title: 'Leaf logo' }), warnings: ['This logo has no transparency.'] } }))
    const { zone } = setup('logo')
    fireEvent.drop(zone(), { dataTransfer: { files: [file('leaf.png', 'image/png')] } })
    expect(await screen.findByText('This logo has no transparency.')).toBeInTheDocument()
    expect(sent[0].url).toBe('/api/brand-kits/assets?purpose=logo')
  })
})

describe('brand upload rules', () => {
  it('accepts TTF/OTF fonts only, and logos without JPEG', () => {
    expect(checkBrandFile(file('Brand.ttf', ''), 'font')).toBeNull()
    expect(checkBrandFile(file('Brand.OTF', 'font/otf'), 'font')).toBeNull()
    expect(checkBrandFile(file('Brand.woff2', 'font/woff2'), 'font')).toMatch(/Try TTF or OTF up to 10 MB/)
    expect(checkBrandFile(file('Brand.ttf', '', 11 * 1024 * 1024), 'font')).toMatch(/bigger than the 10 MB limit/)
    expect(checkBrandFile(file('logo.jpg', 'image/jpeg'), 'logo')).toMatch(/can't be see-through/)
    expect(checkBrandFile(file('logo.svg', 'image/svg+xml'), 'logo')).toBeNull()
  })

  it('words 413 and 415 for each purpose', () => {
    expect(brandUploadErrorText('logo')(413, undefined, 'l.png')).toMatch(/too big for the server. The limit is 5 MB/)
    expect(brandUploadErrorText('font')(415, 'bad', 'f.ttf')).toMatch(/isn't a working TTF or OTF font/)
    expect(brandUploadErrorText('logo')(415, 'bad', 'l.svg')).toMatch(/plain SVG without scripts/)
  })
})
