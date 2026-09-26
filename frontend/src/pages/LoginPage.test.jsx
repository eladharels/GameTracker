// Behaviour tests for the login page (FE-4, the SEC-7 notice, SEC-14's cookie session).
// These replace the source-text pin for the "session ended" notice in
// test/runtime.test.js (UP-20).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { api } from '../api'
import LoginPage from './LoginPage'
import { getSession, markSessionEnded, markSignInUpdated, readHint, setSession } from '../session'

// What the server answers: POST /api/auth/login {session} sets the cookie, then
// GET /api/auth/session says who is signed in (SEC-14). No token reaches the page.
const view = (username) => ({ username, can_manage_users: false, origin: 'local', display_name: username, exp: 9e9, expiresIn: 3600 })
const signsInAs = (username) => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { session: view(username) } })
  vi.spyOn(api, 'get').mockResolvedValue({ data: { session: view(username) } })
  return post
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); setSession(null) })
afterEach(() => vi.restoreAllMocks())
afterEach(cleanup)

function renderLogin(setUser = vi.fn()) {
  // StrictMode, as main.jsx renders it: it double-invokes state initializers and effects on
  // mount, which is exactly why peekSessionEnd must not consume the flag (see session.js).
  render(<StrictMode><MemoryRouter initialEntries={['/login']}><LoginPage setUser={setUser} /></MemoryRouter></StrictMode>)
  return setUser
}
function submit(username = 'jane', password = 'pw') {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}
const rejectWith = (status, error) => vi.spyOn(api, 'post').mockRejectedValue(
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
  it('never blames the password for an outage', async () => {
    rejectWith(503); renderLogin(); submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/temporarily unavailable/)
  })
  it('never blames the password for a network failure', async () => {
    rejectWith(null); renderLogin(); submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/reach the server/)
  })
  it('disables the button while signing in', async () => {
    let resolve
    vi.spyOn(api, 'post').mockReturnValue(new Promise((r) => { resolve = r }))
    renderLogin(); submit()
    const button = screen.getByRole('button', { name: /signing in/i })
    expect(button.disabled).toBe(true)
    vi.spyOn(api, 'get').mockResolvedValue({ data: { session: view('jane') } })
    resolve({ data: { session: view('jane') } })
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
  it('signs in with a COOKIE session: asks for one, confirms it, stores no credential (SEC-14)', async () => {
    const post = signsInAs('jane')
    const setUser = renderLogin(); submit()
    await waitFor(() => expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ username: 'jane' })))
    expect(post.mock.calls[0][1]).toMatchObject({ username: 'jane', session: 'cookie' })
    expect(getSession()).toMatchObject({ username: 'jane' })
    expect(readHint()).toEqual({ username: 'jane', exp: 9e9 })       // a hint, not a credential
    expect(localStorage.getItem('token')).toBeNull()
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/eyJ/)   // no JWT anywhere in storage
  })
  it('says so when the BROWSER refused the cookie, instead of looping (condition 17)', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ data: { session: view('jane') } })
    vi.spyOn(api, 'get').mockRejectedValue({ response: { status: 401, data: {} } })
    const setUser = renderLogin(); submit()
    expect((await screen.findByRole('alert')).textContent).toMatch(/refused the sign-in cookie/)
    expect(setUser).not.toHaveBeenCalled()
    expect(getSession()).toBeNull()
  })
  it('shows the one-time "sign-in has been updated" line after the old token was removed', () => {
    markSignInUpdated()
    renderLogin()
    expect(screen.getByRole('status').textContent).toMatch(/Sign-in has been updated/)
    cleanup()
    renderLogin()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// Where sign-in LANDS after an ended session (FE-14). The stored return path belongs to
// whoever's session ended; on a shared machine the next person is often someone else.
function Where() { return <output data-testid="where">{useLocation().pathname}</output> }
function renderRouted() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage setUser={vi.fn()} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  )
}
describe('the return path after an ended session (FE-14)', () => {
  it('takes the SAME user back to where their session ended', async () => {
    markSessionEnded('/user/alice/library', 'alice')
    signsInAs('alice')
    renderRouted(); submit('alice')
    expect((await screen.findByTestId('where')).textContent).toBe('/user/alice/library')
  })
  it("never sends a DIFFERENT user to the previous user's page", async () => {
    markSessionEnded('/user/alice/library', 'alice')
    signsInAs('bob')
    renderRouted(); submit('bob')
    expect((await screen.findByTestId('where')).textContent).toBe('/search')
  })
})
