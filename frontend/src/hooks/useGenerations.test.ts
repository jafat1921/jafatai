import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { Generation } from '@/lib/types'
import { qk } from './keys'
import { upsertGeneration } from './useGenerations'

const gen = (id: string, version: number, status: Generation['status']): Generation => ({
  id,
  version,
  status,
  target_type: 'character',
  target_id: 'c1',
  kind: 'portrait',
  prompt: 'p',
  params: {},
  seed: 1,
  created_at: '2026-10-04T00:00:00Z',
})

describe('upsertGeneration', () => {
  it('keeps one approved version per target and respects the rejected filter', () => {
    const qc = new QueryClient()
    const visible = qk.generations('character', 'c1', 'portrait', false)
    const all = qk.generations('character', 'c1', 'portrait', true)
    qc.setQueryData(visible, [gen('b', 2, 'ready'), gen('a', 1, 'approved')])
    qc.setQueryData(all, [gen('b', 2, 'ready'), gen('a', 1, 'approved')])

    upsertGeneration(qc, gen('b', 2, 'approved'))
    expect(qc.getQueryData<Generation[]>(visible)!.map((g) => [g.id, g.status])).toEqual([
      ['b', 'approved'],
      ['a', 'ready'],
    ])

    upsertGeneration(qc, gen('a', 1, 'rejected'))
    expect(qc.getQueryData<Generation[]>(visible)!.map((g) => g.id)).toEqual(['b'])
    expect(qc.getQueryData<Generation[]>(all)!.find((g) => g.id === 'a')?.status).toBe('rejected')

    upsertGeneration(qc, gen('c', 3, 'queued'))
    expect(qc.getQueryData<Generation[]>(visible)![0].id).toBe('c')
  })
})
