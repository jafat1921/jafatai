import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, onUnauthorized } from './api'

function respond(status: number, body?: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('api client', () => {
  const handler = vi.fn()

  beforeEach(() => {
    handler.mockReset()
    onUnauthorized(handler)
  })
  afterEach(() => {
    onUnauthorized(null)
    vi.unstubAllGlobals()
  })

  it('sends credentials and JSON, and returns parsed data', async () => {
    const fetchMock = respond(200, [{ id: 'p1' }])
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.projects.list()).resolves.toEqual([{ id: 'p1' }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects')
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' })
  })

  it('throws ApiError(401) and fires the unauthorized handler when a session expires', async () => {
    vi.stubGlobal('fetch', respond(401, { detail: 'Not authenticated' }))
    const err = await api.projects.list().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('Not authenticated')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not treat a failed login as an expired session', async () => {
    vi.stubGlobal('fetch', respond(401, { detail: 'Invalid email or password' }))
    await expect(api.auth.login('a@b.c', 'nope')).rejects.toMatchObject({ status: 401 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('flattens FastAPI 422 validation errors into a readable message', async () => {
    vi.stubGlobal(
      'fetch',
      respond(422, { detail: [{ loc: ['body', 'title'], msg: 'Field required', type: 'missing' }] }),
    )
    await expect(api.projects.create({ title: '', authoring_mode: 'ai_director' })).rejects.toMatchObject({
      status: 422,
      message: 'title: Field required',
    })
  })

  it('handles 204 and builds query strings without empty params', async () => {
    vi.stubGlobal('fetch', respond(204))
    await expect(api.scenes.remove('s1')).resolves.toBeUndefined()

    const fetchMock = respond(200, [])
    vi.stubGlobal('fetch', fetchMock)
    await api.generations.list({ target_type: 'character', target_id: 'c1', kind: 'portrait', include_rejected: false })
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/generations?target_type=character&target_id=c1&kind=portrait&include_rejected=false',
    )
  })

  it('reports network failures as status 0 with a helpful message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(api.auth.me()).rejects.toMatchObject({ status: 0 })
    expect(handler).not.toHaveBeenCalled()
  })
})
