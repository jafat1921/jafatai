import { describe, expect, it } from 'vitest'
import { generationStatus, jobLabel, jobStatus, kindLabel, projectStatus } from './status'
import type { GenerationStatus, JobStatus, ProjectStatus } from './types'

describe('status pills use plain language', () => {
  it.each<[GenerationStatus, string]>([
    ['queued', 'Waiting in queue'],
    ['ready', 'Ready for review'],
    ['approved', 'Approved'],
    ['rejected', 'Rejected'],
    ['failed', 'Failed'],
  ])('generation %s → %s', (status, label) => {
    expect(generationStatus(status).label).toBe(label)
  })

  it('includes rounded, clamped progress while generating', () => {
    expect(generationStatus('generating', 0.424).label).toBe('Generating 42%')
    expect(generationStatus('generating', 1.7).label).toBe('Generating 100%')
    expect(generationStatus('generating').label).toBe('Generating')
  })

  it.each<[JobStatus, string]>([
    ['queued', 'Waiting'],
    ['done', 'Done'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ])('job %s → %s', (status, label) => {
    expect(jobStatus(status).label).toBe(label)
  })

  it.each<[ProjectStatus, string]>([
    ['draft', 'Draft'],
    ['in_progress', 'In progress'],
    ['rendering', 'Rendering'],
    ['done', 'Finished'],
  ])('project %s → %s', (status, label) => {
    expect(projectStatus(status).label).toBe(label)
  })

  it('never leaks raw snake_case codes', () => {
    const all = [
      ...(['queued', 'generating', 'ready', 'approved', 'rejected', 'failed'] as const).map((s) => generationStatus(s, 0.5)),
      ...(['queued', 'running', 'done', 'failed', 'cancelled'] as const).map((s) => jobStatus(s, 0.5)),
      ...(['draft', 'in_progress', 'rendering', 'done'] as const).map((s) => projectStatus(s)),
    ]
    for (const s of all) expect(s.label).not.toMatch(/_/)
    expect(kindLabel('keyframe_start')).toBe('Start frame')
    expect(jobLabel('some_new_job')).toBe('Some new job')
  })

  it('pairs danger and success tones with an icon', () => {
    expect(generationStatus('failed')).toMatchObject({ tone: 'danger', icon: 'alert' })
    expect(generationStatus('approved')).toMatchObject({ tone: 'success', icon: 'check' })
  })
})
