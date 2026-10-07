import { describe, expect, it } from 'vitest'
import { autopilotJob, stage } from '@/test/quick-fixtures'
import { DEFAULT_QUICK_FORM, currentStage, etaText, hasStarted, quickJobFor, quickPayload, quickStatus, readStages } from './quick'

describe('quickPayload', () => {
  it('sends the contract shape with the trimmed prompt', () => {
    expect(quickPayload({ ...DEFAULT_QUICK_FORM, prompt: '  A fox at sea  ' }, 'fast')).toEqual({
      prompt: 'A fox at sea',
      duration_s: 30,
      aspect_ratio: '16:9',
      style: 'cinematic',
      dialogue: true,
      upscale: null,
    })
  })

  it('asks for a 1080p upscale with the default engine only when toggled', () => {
    const f = { ...DEFAULT_QUICK_FORM, prompt: 'x', upscale: true, dialogue: false, style: 'animated' as const }
    expect(quickPayload(f, 'best')).toMatchObject({ upscale: { engine: 'best', target: '1080p' }, dialogue: false, style: 'animated' })
    // no engine on the server: never send a request the backend will refuse
    expect(quickPayload(f, undefined).upscale).toBeNull()
  })

  it('clamps custom lengths into the contract range', () => {
    expect(quickPayload({ ...DEFAULT_QUICK_FORM, durationS: 2 }, undefined).duration_s).toBe(5)
    expect(quickPayload({ ...DEFAULT_QUICK_FORM, durationS: 5000 }, undefined).duration_s).toBe(1200)
    expect(quickPayload({ ...DEFAULT_QUICK_FORM, durationS: 90 }, undefined).duration_s).toBe(90)
  })
})

describe('stages', () => {
  it('shows a placeholder timeline before the server reports stages', () => {
    const s = readStages(autopilotJob())
    expect(s.map((x) => x.label)).toEqual(['Writing', 'Cast', 'Storyboard', 'Rendering', 'Stitching', 'Upscaling'])
    expect(s[0].status).toBe('running')
  })

  it('finds the current stage and phrases the ETA honestly', () => {
    const stages = [stage('outline', 'Writing', 'done'), stage('cast', 'Cast', 'running'), stage('render', 'Rendering', 'pending')]
    expect(currentStage(stages)?.key).toBe('cast')
    expect(etaText(null)).toMatch(/working out/i)
    expect(etaText(30)).toBe('Almost there')
    expect(etaText(600)).toBe('About 10 min left')
  })

  it('picks the newest autopilot job for the project', () => {
    const jobs = [
      autopilotJob({ id: 'old', created_at: '2026-10-06T00:00:00Z' }),
      autopilotJob({ id: 'new' }),
      autopilotJob({ id: 'other', type: 'reel_assemble', result: {} }),
    ]
    expect(quickJobFor(jobs, 'q1')?.id).toBe('new')
    expect(quickJobFor(jobs, 'nope')).toBeUndefined()
  })
})

describe('autopilot re-queued between stages', () => {
  it('reads as in progress once a stage has started', () => {
    const job = {
      id: 'j', type: 'autopilot', status: 'queued', progress: 0, message: 'Rendering 2 of 5 takes',
      project_id: 'p', created_at: '2026-10-07T00:00:00Z',
      result: { stages: [
        { key: 'outline', label: 'Writing', status: 'done' },
        { key: 'render', label: 'Rendering', status: 'running' },
      ] },
    } as unknown as Parameters<typeof quickStatus>[0]
    expect(hasStarted(job)).toBe(true)
    expect(quickStatus(job).label).toBe('Rendering')
  })
})
