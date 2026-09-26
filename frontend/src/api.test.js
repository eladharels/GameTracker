// The shared client's two interceptors (FE-16). They used to be installed on the GLOBAL
// axios by App.jsx's import; now they belong to this instance, so they are testable
// without rendering the app. A stub adapter answers every request — nothing leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, API_BASE } from './api'
import { peekSessionEnd } from './session'

let seen
const answer = (status) => (config) => {
  seen = config
  if (status >= 400) {
    const err = new Error(`status ${status}`)
    err.config = config
    err.response = { status, data: {}, headers: {}, config }
    return Promise.reject(err)
  }
  return Promise.resolve({ status, data: {}, headers: {}, config, statusText: 'OK' })
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); seen = null })
afterEach(() => { api.defaults.adapter = undefined })

describe('api: the token goes to OUR API and nowhere else', () => {
  it('attaches the stored token to /api/ requests, absolute or relative', async () => {
    localStorage.setItem('token', 't0k')
    api.defaults.adapter = answer(200)
    await api.get(`${API_BASE}/user/me`)
    expect(seen.headers.Authorization).toBe('Bearer t0k')
    await api.get('/api/user/me')
    expect(seen.headers.Authorization).toBe('Bearer t0k')
  })
  it('never sends it to another host, or to the SPA\'s own /api-docs route', async () => {
    localStorage.setItem('token', 't0k')
    api.defaults.adapter = answer(200)
    for (const url of ['https://images.igdb.com/x.jpg', `${window.location.origin}/api-docs`, '/api-docs']) {
      await api.get(url)
      expect(seen.headers.Authorization, url).toBeUndefined()
    }
  })
  it('is this INSTANCE\'s behaviour, not the global axios\'s', async () => {
    const { default: axios } = await import('axios')
    expect(axios.interceptors.request.handlers.filter(Boolean)).toHaveLength(0)
    expect(axios.interceptors.response.handlers.filter(Boolean)).toHaveLength(0)
  })
})

describe('api: a 401 ends the session (P0-6), and only a 401 does', () => {
  it('a 401 removes the token, records why, and goes to /login', async () => {
    localStorage.setItem('token', 't0k')
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, pathname: '/library', assign })
    api.defaults.adapter = answer(401)
    await expect(api.get(`${API_BASE}/user/me`)).rejects.toBeTruthy()
    expect(localStorage.getItem('token')).toBeNull()
    expect(assign).toHaveBeenCalledWith('/login')
    expect(peekSessionEnd()).toMatchObject({ from: '/library' })
  })
  it('a 403 leaves the session alone — it is an answer, not a logout', async () => {
    localStorage.setItem('token', 't0k')
    api.defaults.adapter = answer(403)
    await expect(api.get(`${API_BASE}/users`)).rejects.toBeTruthy()
    expect(localStorage.getItem('token')).toBe('t0k')
    expect(peekSessionEnd()).toBeNull()
  })
})
