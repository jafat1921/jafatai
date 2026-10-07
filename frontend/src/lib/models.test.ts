import { describe, expect, it } from 'vitest'
import { CATALOG } from '@/test/model-fixtures'
import { DEFAULT_IMAGE_FORM, addSources, editPayload, imagePayload } from './images'
import { capabilityLabels, estimateSeconds, FALLBACK_MODELS, pickModel } from './models'
import { menusFrom } from './nav'
import { DEFAULT_QUICK_FORM, quickPayload } from './quick'
import { DEFAULT_VIDEO_FORM, durationPresets, videoBlockedReason, videoPayload } from './video'

const byId = (id: string) => Object.values(CATALOG).flat().find((m) => m.id === id)!

describe('model catalog helpers', () => {
  it('picks the wanted model, understands old ?model= ids, and never lands on an unavailable one', () => {
    expect(pickModel(CATALOG.image, 'qwen_image_2512')?.id).toBe('qwen_image_2512')
    expect(pickModel(CATALOG.image, 'flux2_klein')?.id).toBe('zimage_turbo')
    expect(pickModel(CATALOG.image, 'z-image-turbo')?.id).toBe('zimage_turbo')
    expect(pickModel(CATALOG.edit, 'qwen-image-edit')?.id).toBe('qwen_image_edit_2511')
    expect(pickModel(CATALOG.video, null)?.id).toBe('ltx23_distilled')
  })

  it('labels capabilities in plain words, and every video model says whether it has sound', () => {
    const text = (id: string) => capabilityLabels(byId(id)).map((c) => c.text)
    expect(text('ltx23_distilled')).toEqual(['Sound', 'Start image', 'First & last frame', 'Long takes'])
    expect(text('wan22_t2v')).toEqual(['No sound', 'Text only'])
    expect(text('qwen_image_2512')).toEqual(['Text in images'])
    expect(text('qwen_image_edit_2511')).toEqual(['Up to 3 refs', 'Multi-angle'])
    expect(text('flux2_klein_edit')).toEqual(['1 reference'])
  })

  it('scales the time estimate with the speed', () => {
    const qwen = byId('qwen_image_2512')
    expect(estimateSeconds(qwen)).toBe(30)
    expect(estimateSeconds(qwen, 'lightning4')).toBe(5)
    expect(estimateSeconds(qwen, 'turbo2')).toBe(3)
    expect(estimateSeconds(byId('zimage_turbo'), 'whatever')).toBe(7)
  })

  it('builds the mega-menu Models columns from the catalog, available models only', () => {
    const menus = menusFrom(CATALOG)
    const names = (id: 'image' | 'video' | 'upscale') => menus[id].models.map((m) => m.name)
    expect(names('image')).toEqual(['Z-Image Turbo', 'Qwen-Image 2512', 'Qwen-Image-Edit 2511', 'FLUX.2 klein 4B (base)', 'SeedVR2 3B / 7B', 'Real-ESRGAN ×4'])
    expect(menus.image.models[1]).toMatchObject({ to: '/image/generate?model=qwen_image_2512', badge: 'TEXT' })
    expect(menus.image.models[2].to).toBe('/image/edit?model=qwen_image_edit_2511')
    expect(names('video')).toEqual(['LTX-2.3', 'LTX-2.3 High quality', 'Wan 2.2 14B', 'SeedVR2'])
    expect(menus.video.models[2].to).toBe('/video/create?model=wan22_t2v')
    // FlashVSR is marked unavailable in this catalog
    expect(names('upscale')).not.toContain('FlashVSR 1.1 · video')
    expect(menus.video.features.map((f) => f.title)).toContain('Create Video')
  })

  it('the fallback menus only list what an older server runs', () => {
    const menus = menusFrom(FALLBACK_MODELS)
    expect(menus.image.models.map((m) => m.id)).toEqual(['zimage_turbo', 'qwen_image_edit_2511', 'seedvr2', 'realesrgan'])
    expect(menus.video.models.map((m) => m.id)).toEqual(['ltx23_distilled', 'seedvr2', 'flashvsr'])
  })
})

describe('payloads with a model', () => {
  it('image generate sends model and speed only when set', () => {
    expect(imagePayload({ ...DEFAULT_IMAGE_FORM, prompt: 'poster' })).toEqual({ prompt: 'poster', aspect: '1:1', count: 2 })
    expect(imagePayload({ ...DEFAULT_IMAGE_FORM, prompt: 'poster', model: 'qwen_image_2512', speed: 'lightning4' })).toMatchObject({
      model: 'qwen_image_2512',
      speed: 'lightning4',
    })
  })

  it('image edit respects the model max_refs', () => {
    expect(addSources(['a'], ['b', 'c'], 1)).toEqual({ ids: ['a'], dropped: 2 })
    expect(editPayload(['a', 'b', 'c'], 'night', 1, null, byId('flux2_klein_edit'))).toEqual({
      source_ids: ['a'],
      instruction: 'night',
      count: 1,
      model: 'flux2_klein_edit',
    })
  })

  it('video: Wan is blocked with a start image, duration is capped by the model, smooth motion only when supported', () => {
    const wan = byId('wan22_t2v')
    const ltx = byId('ltx23_distilled')
    expect(videoBlockedReason(wan, true)).toMatch(/text only/)
    expect(videoBlockedReason(wan, false)).toBeNull()
    expect(videoBlockedReason(ltx, true)).toBeNull()
    expect(durationPresets(wan).map((p) => p.value)).toEqual([5])
    expect(durationPresets({ ...byId('ltx23_hq'), max_duration_s: 10.67 }).map((p) => p.value)).toEqual([5, 10])

    const form = { ...DEFAULT_VIDEO_FORM, prompt: ' gulls ', durationS: 30, imageId: 'img1', smooth: true, seed: '9' }
    // 30 s is a long take: smooth motion is single-pass only, so it's left out
    expect(videoPayload(form, ltx)).toEqual({ prompt: 'gulls', model: 'ltx23_distilled', duration_s: 30, aspect: '16:9', image_id: 'img1', seed: 9 })
    expect(videoPayload({ ...form, durationS: 8 }, ltx)).toMatchObject({ duration_s: 8, smooth_motion: true })
    expect(videoPayload(form, wan)).toEqual({ prompt: 'gulls', model: 'wan22_t2v', duration_s: 5, aspect: '16:9', seed: 9 })
  })

  it('quick create adds image_model and video_quality from the advanced options', () => {
    const base = { ...DEFAULT_QUICK_FORM, prompt: 'x' }
    expect(quickPayload(base, undefined)).not.toHaveProperty('image_model')
    expect(quickPayload(base, undefined)).not.toHaveProperty('video_quality')
    expect(quickPayload({ ...base, imageModel: 'qwen_image_2512', videoQuality: 'hq' }, undefined)).toMatchObject({
      image_model: 'qwen_image_2512',
      video_quality: 'hq',
    })
  })
})
