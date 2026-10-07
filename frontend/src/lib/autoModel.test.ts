import { describe, expect, it } from 'vitest'
import { CATALOG } from '@/test/model-fixtures'
import { media } from '@/test/media-fixtures'
import type { ModelInfo } from './types'
import { AUTO_ID, guessAuto, modelLabel, modelToSend, modelUsedId, pickModel, withAuto } from './models'
import { sessionRows } from './sessions'

const flux: ModelInfo = { ...CATALOG.image[2], available: true }
const images = [CATALOG.image[0], CATALOG.image[1], flux]

describe('Auto model', () => {
  it('puts Auto first and makes it the default, standing in for the default model on older servers', () => {
    const { models, serverAuto } = withAuto(CATALOG.video, 'video')
    expect(serverAuto).toBe(false)
    expect(models[0]).toMatchObject({ id: AUTO_ID, label: 'Auto', default: true, capabilities: CATALOG.video[0].capabilities })
    expect(pickModel(models)?.id).toBe(AUTO_ID)
    expect(models.slice(1).map((m) => m.id)).toEqual(CATALOG.video.map((m) => m.id))
  })

  it("uses the server's Auto entry and fills in missing capabilities", () => {
    const server = { id: 'auto', type: 'video', label: 'Auto', badge: null, description: 'Picks the best model', capabilities: [], available: true, default: false } as ModelInfo
    const { models, serverAuto } = withAuto([server, ...CATALOG.video], 'video')
    expect(serverAuto).toBe(true)
    expect(models[0]).toMatchObject({ id: 'auto', default: true, description: 'Picks the best model' })
    expect(models[0].capabilities).toContain('i2v')
  })

  it('mirrors the server rules: text → Qwen-Image, four or more → FLUX klein, else the default', () => {
    expect(guessAuto('image', images, { prompt: 'a fox in snow' })?.id).toBe('zimage_turbo')
    expect(guessAuto('image', images, { prompt: 'A poster that says "Open"' })?.id).toBe('qwen_image_2512')
    expect(guessAuto('image', images, { prompt: 'عید مبارک' })?.id).toBe('qwen_image_2512')
    expect(guessAuto('image', images, { prompt: 'a billboard at night' })?.id).toBe('qwen_image_2512')
    expect(guessAuto('image', images, { prompt: 'a fox', count: 4 })?.id).toBe('flux2_klein')
    // an unavailable pick is skipped
    expect(guessAuto('image', CATALOG.image, { prompt: 'a fox', count: 4 })?.id).toBe('zimage_turbo')
  })

  it('sends "auto" only to a server that knows it', () => {
    const { models } = withAuto(images, 'image')
    expect(modelToSend('image', models, models[0], true)?.id).toBe('auto')
    expect(modelToSend('image', models, models[0], false, { prompt: 'a sign that says hi' })?.id).toBe('qwen_image_2512')
    expect(modelToSend('image', models, images[0], false)?.id).toBe('zimage_turbo')
  })

  it('reads the model actually used and names it', () => {
    expect(modelUsedId({ model: 'auto', model_resolved: 'flux2_klein' })).toBe('flux2_klein')
    expect(modelUsedId(null, { model: 'auto' }, { model: 'zimage_turbo' })).toBe('zimage_turbo')
    expect(modelUsedId({ model: 'auto' })).toBeNull()
    expect(modelLabel({ image: CATALOG.image }, 'qwen_image_2512')).toBe('Qwen-Image 2512')
    expect(modelLabel({}, 'some_new_model')).toBe('some new model')
  })
})

describe('session rows', () => {
  const at = (s: number) => new Date(Date.parse('2026-10-07T10:00:00Z') + s * 1000).toISOString()

  it('gives each request made here its own row, and groups history by prompt and time', () => {
    const items = [
      media('n1', { prompt: 'fox', created_at: at(300) }),
      media('n2', { prompt: 'fox', created_at: at(300) }),
      media('h1', { prompt: 'harbour', created_at: at(100) }),
      media('h2', { prompt: 'harbour', created_at: at(90) }),
      media('h3', { prompt: 'harbour', created_at: at(-600) }),
    ]
    const rows = sessionRows(items, [{ id: 's1', page: 'p', at: at(301), prompt: 'fox', summary: 'Auto · 1:1', itemIds: ['n1', 'n2'], settings: {} }])
    expect(rows.map((r) => [r.key, r.items.map((m) => m.id)])).toEqual([
      ['s1', ['n1', 'n2']],
      ['h-h1', ['h1', 'h2']],
      ['h-h3', ['h3']],
    ])
    expect(rows[0].request?.summary).toBe('Auto · 1:1')
    expect(rows[1].summary).toBe('2 images · 1024×1024')
  })
})
