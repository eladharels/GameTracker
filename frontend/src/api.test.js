// The shared client's two interceptors (FE-16, SEC-14). They belong to this instance, so they
// are testable without rendering the app. A stub adapter answers every request — nothing
// leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, API_BASE, probeSession } from './api'
import { getSession, peekSessionEnd, sessionFromView, setSession } from './session'

let seen
let calls
const answer = (status, data = {}) => (config) => {
  seen = config
  calls.push(config)
  if (status >= 400) {
    const err = new Error(`status ${status}`)
    err.config = config
    err.response = { status, data: {}, headers: {}, config }
    return Promise.reject(err)
  }
  return Promise.resolve({ status, data, headers: {}, config, statusText: 'OK' })
}
const signedIn = () => setSession(sessionFromView({ username: 'jane', expiresIn: 3600, exp: 9e9 }))

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); seen = null; calls = []; setSession(null) })
afterEach(() => { api.defaults.adapter = undefined; vi.restoreAllMocks() })

describe('api: the CSRF header goes to OUR API and nowhere else (SEC-14)', () => {
  it('adds X-Requested-With to /api/ requests, absolute or relative, and NEVER an Authorization header', async () => {
    signedIn()
    api.defaults.adapter = answer(200)
    for (const url of [`${API_BASE}/user/me`, '/api/user/me']) {
      await api.get(url)
      expect(seen.headers['X-Requested-With'], url).toBe('GameTracker')
      expect(seen.headers.Authorization, url).toBeUndefined()
    }
  })
  it('never sends it to another host, or to the SPA\'s own /api-docs route', async () => {
    api.defaults.adapter = answer(200)
    for (const url of ['https://images.igdb.com/x.jpg', `${window.location.origin}/api-docs`, '/api-docs']) {
      await api.get(url)
      expect(seen.headers['X-Requested-With'], url).toBeUndefined()
    }
  })
  it('is this INSTANCE\'s behaviour, not the global axios\'s', async () => {
    const { default: axios } = await import('axios')
    expect(axios.interceptors.request.handlers.filter(Boolean)).toHaveLength(0)
    expect(axios.interceptors.response.handlers.filter(Boolean)).toHaveLength(0)
  })
})

describe('api: a 401 ends the session (P0-6), and only a 401 does', () => {
  it('a 401 ends the in-memory session, records why, logs out server-side, and goes to /login', async () => {
    signedIn()
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, pathname: '/library', assign })
    api.defaults.adapter = answer(401)
    await expect(api.get(`${API_BASE}/user/me`)).rejects.toBeTruthy()
    expect(getSession()).toBeNull()
    expect(assign).toHaveBeenCalledWith('/login')
    expect(peekSessionEnd()).toMatchObject({ from: '/library', owner: 'jane' })
    // The server-side logout ran (it clears the HttpOnly cookie JS cannot), exactly once --
    // its own 401 must not re-enter endSession (condition 13).
    expect(calls.filter((c) => c.url.endsWith('/auth/logout'))).toHaveLength(1)
  })
  it('a 403 leaves the session alone — it is an answer, not a logout', async () => {
    signedIn()
    api.defaults.adapter = answer(403)
    await expect(api.get(`${API_BASE}/users`)).rejects.toBeTruthy()
    expect(getSession()).not.toBeNull()
    expect(peekSessionEnd()).toBeNull()
  })
  it('a 401 with NO session (the boot or post-login probe) ends nothing and redirects nowhere', async () => {
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, pathname: '/login', assign })
    api.defaults.adapter = answer(401)
    await expect(probeSession()).rejects.toMatchObject({ response: { status: 401 } })
    expect(assign).not.toHaveBeenCalled()
    expect(peekSessionEnd()).toBeNull()
  })
})
