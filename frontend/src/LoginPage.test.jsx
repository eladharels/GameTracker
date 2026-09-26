// Behaviour tests for the login page (FE-4, SEC-7 notice, clock skew). These replace the
// source-text pin for the "session ended" notice in test/runtime.test.js (UP-20).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import axios from 'axios'
import { LoginPage } from './App'
import { markSessionEnded } from './session'

const fakeJwt = (payload) => ['x', btoa(JSON.stringify(payload)).replace(/=+$/, ''), 'sig'].join('.')

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(cleanup)

function renderLogin(setUser = vi.fn()) {
  render(<MemoryRouter initialEntries={['/login']}><LoginPage setUser={setUser} /></MemoryRouter>)
  return setUser
}
function submit(username = 'jane', password = 'pw') {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}
const rejectWith = (status, error) => vi.spyOn(axios, 'post').mockRejectedValue(
  status ? { response: { status, data: error ? { error } : {} } } : new Error('Network Error'))

describe('LoginPage errors (FE-4)', () => {
  it('says "wrong password" only for a 401', async () => {
    rejectWith(401, 'Invalid credentials'); renderLogin(); submit()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid username or password.')
  })
  it('shows the lockout with its minutes for a 429', async () => {
    rejectWith(429, 'Too many sign-in attempts. Please try again in 3 minutes.'); renderLogin(); submit()
    expect((await screen.findByRole('alert')).textContent).toContain('3 minutes')
  })
  it('never blames the password for an outage or a network failure', async () => {
    rejectWith(503); renderLogin(); submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/temporarily unavailable/)
    cleanup(); vi.restoreAllMocks()
    rejectWith(null); renderLogin(); submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/reach the server/)
  })
  it('disables the button while signing in', async () => {
    let resolve
    vi.spyOn(axios, 'post').mockReturnValue(new Promise((r) => { resolve = r }))
    renderLogin(); submit()
    const button = screen.getByRole('button', { name: /signing in/i })
    expect(button.disabled).toBe(true)
    resolve({ data: { token: fakeJwt({ id: 1, username: 'jane', exp: Date.now() / 1000 + 3600 }) } })
    await waitFor(() => expect(screen.queryByRole('button', { name: /signing in/i })).toBeNull())
  })
})

describe('LoginPage session handling (SEC-7)', () => {
  it('shows why the session ended, once', () => {
    markSessionEnded('/library')
    renderLogin()
    expect(screen.getByRole('status').textContent).toMatch(/session has ended/)
    cleanup()
    renderLogin()   // a second visit: the flag was cleared on mount
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('stores a valid token and signs the user in', async () => {
    const token = fakeJwt({ id: 1, username: 'jane', exp: Date.now() / 1000 + 3600 })
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token } })
    const setUser = renderLogin(); submit()
    await waitFor(() => expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ username: 'jane' })))
    expect(localStorage.getItem('token')).toBe(token)
  })
  it('refuses a token the device clock says is expired, and says why', async () => {
    const token = fakeJwt({ id: 1, username: 'jane', exp: Date.now() / 1000 - 60 })
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { token } })
    const setUser = renderLogin(); submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/date and time/)
    expect(setUser).not.toHaveBeenCalled()
    expect(localStorage.getItem('token')).toBeNull()
  })
})
