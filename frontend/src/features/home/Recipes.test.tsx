import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockApi, renderAt } from '@/test/media-fixtures'
import { Recipes } from './Recipes'

afterEach(() => vi.unstubAllGlobals())

function Landed() {
  const loc = useLocation()
  const tpl = (loc.state as { template?: { templateTitle: string; prefill: Record<string, unknown> } } | null)?.template
  return <output data-testid="prefill">{tpl ? `${tpl.templateTitle}|${JSON.stringify(tpl.prefill)}` : 'none'}</output>
}

const routes = [
  { path: '/', element: <Recipes /> },
  ...['/image/generate', '/video/quick', '/video/img2vid', '/video/upscale', '/brand-kits', '/brand-kits/:kitId'].map((path) => ({ path, element: <Landed /> })),
]

function api(kits: unknown[] = []) {
  return mockApi((method, path) => {
    if (path === '/brand-kits') return kits
    if (method === 'POST' && path === '/templates/image-poster/start') return { target: 'image', prefill: { prompt: 'A poster that says "[TEXT]"', aspect: '2:3' } }
    if (method === 'POST' && path === '/templates/video-product-ad-30s/start') return { target: 'quick', prefill: { prompt: 'An ad for [product]', duration_s: 30 } }
  })
}

describe('blueprints', () => {
  it('Poster with text opens Create Image on Qwen with the template filled in', async () => {
    const calls = api()
    renderAt('/', routes)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Poster with text/ }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/image/generate?model=qwen_image_2512'))
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/templates/image-poster/start' }))
    expect(screen.getByTestId('prefill')).toHaveTextContent('Poster with text|{"prompt":"A poster that says \\"[TEXT]\\"","aspect":"2:3"}')
  })

  it('route recipes go straight to their tool; Quick film carries its own prefill', async () => {
    api()
    renderAt('/', routes)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Quick film/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/video/quick')
    expect(screen.getByTestId('prefill')).toHaveTextContent('"duration_s":30')
  })

  it.each([
    ['Animate a still', '/video/img2vid'],
    ['Upscale my video', '/video/upscale'],
    ['Brand logo reveal', '/brand-kits'],
  ])('%s opens %s', async (name, to) => {
    api()
    renderAt('/', routes)
    await userEvent.setup().click(screen.getByRole('button', { name: new RegExp(name) }))
    expect(screen.getByTestId('location')).toHaveTextContent(to)
  })

  it('Instant brand appears with a kit, and the logo reveal opens that kit', async () => {
    api([{ id: 'k1', name: 'Acme', is_default: true }])
    renderAt('/', routes)
    const user = userEvent.setup()
    const brand = await screen.findByRole('region', { name: /Instant brand · Acme/ })
    expect(within(brand).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('On-brand product shot'),
      expect.stringContaining('Vertical teaser'),
      expect.stringContaining('Brand story'),
    ])
    await user.click(screen.getByRole('button', { name: /Brand logo reveal/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('/brand-kits/k1')
  })

  it('no kit, no Instant brand', async () => {
    api()
    renderAt('/', routes)
    await screen.findByRole('button', { name: /Product ad/ })
    expect(screen.queryByRole('region', { name: /Instant brand/ })).not.toBeInTheDocument()
  })
})
