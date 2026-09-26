// The app shell's session behaviour through the REAL route table (FE-14, FE-22, SEC-14).
// LoginPage.test.jsx routes '*' to a location probe, so it could not see the signed-in
// catch-all <Navigate to="/search"/> overtaking the return path — which is exactly what
// React Router 7's default transitions did. This renders App itself, with the router props
// main.jsx ships.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { api } from './api'
import { getSession, markSessionEnded, peekSessionEnd, setSession, writeHint } from './session'
import { ToastProvider } from './contexts/ToastContext'
import { ROUTER_PROPS } from './routerConfig'

const view = (username) => ({ username, can_manage_users: false, origin: 'local', display_name: username, exp: 9e9, expiresIn: 3600 })

// The server, as far as the SPA can tell: who (if anyone) the session cookie belongs to.
let serverSession
let probeFailure
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); setSession(null)
  serverSession = null
  probeFailure = null
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url.endsWith('/auth/session')) {
      if (probeFailure) return Promise.reject(probeFailure)
      return serverSession
        ? Promise.resolve({ data: { session: view(serverSession) } })
        : Promise.reject({ response: { status: 401, data: {} } })
    }
    return Promise.resolve({ data: [] })
  })
  vi.spyOn(api, 'post').mockImplementation((url, body) => {
    if (url.endsWith('/auth/login')) { serverSession = body.username; return Promise.resolve({ data: { session: view(body.username) } }) }
    if (url.endsWith('/auth/logout')) { serverSession = null; return Promise.resolve({ data: null }) }
    return Promise.resolve({ data: {} })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderApp(path = '/login') {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]} {...ROUTER_PROPS}>
        <ToastProvider><App /></ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  )
}
async function signIn(username) {
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}
const heading = () => document.querySelector('.page-title')?.textContent

it('the same user signing back in returns to their page, not the catch-all /search', async () => {
  markSessionEnded('/calendar', 'alice')
  renderApp(); await signIn('alice')
  await waitFor(() => expect(heading()).toMatch(/calendar/i))
})
it('a different user lands on /search', async () => {
  markSessionEnded('/calendar', 'alice')
  renderApp(); await signIn('bob')
  await waitFor(() => expect(heading()).toMatch(/search/i))
})

it('boot: a live cookie session opens the app where the user was, with no login flash', async () => {
  serverSession = 'jane'
  renderApp('/calendar')
  // Until the server answers, neither the login form nor the app.
  expect(screen.queryByLabelText('Username')).toBeNull()
  await waitFor(() => expect(heading()).toMatch(/calendar/i))
  expect(getSession()).toMatchObject({ username: 'jane' })
})

it('boot: a server that cannot answer is NOT "signed out" -- it says so, and Retry recovers', async () => {
  probeFailure = { response: { status: 503, data: {} } }
  renderApp('/library')
  expect((await screen.findByRole('alert')).textContent).toMatch(/Can.t reach the server/)
  expect(screen.queryByLabelText('Username')).toBeNull()   // the outage never shows the login page
  probeFailure = null
  serverSession = 'jane'
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(heading()).toMatch(/library/i))
})

it('boot: 401 with an EXPIRED hint explains the ended session; with no hint it stays silent', async () => {
  writeHint({ username: 'jane', exp: Math.floor(Date.now() / 1000) - 60 })
  renderApp('/library')
  expect(await screen.findByText(/session has ended/)).toBeTruthy()
  expect(peekSessionEnd()).toBeNull()   // shown, then cleared on mount
  cleanup()
  localStorage.clear()
  renderApp('/library')
  await screen.findByLabelText('Username')
  expect(screen.queryByText(/session has ended/)).toBeNull()
})

it('boot: the pre-SEC-14 localStorage token is removed and the login page says so once', async () => {
  localStorage.setItem('token', 'eyJ.old.token')
  renderApp('/library')
  expect(await screen.findByText(/Sign-in has been updated/)).toBeTruthy()
  expect(localStorage.getItem('token')).toBeNull()
})

it('another tab signing out ends this tab\'s session too (condition 18)', async () => {
  serverSession = 'jane'
  renderApp('/library')
  await waitFor(() => expect(heading()).toMatch(/library/i))
  const otherTab = new BroadcastChannel('gametracker-session')
  await act(async () => {
    otherTab.postMessage({ type: 'logout', username: 'jane' })
    await new Promise((r) => setTimeout(r, 50))
  })
  otherTab.close()
  expect(await screen.findByLabelText('Username')).toBeTruthy()
  expect(getSession()).toBeNull()
})

it('boot: a NETWORK error (no response at all) is unreachable too, never the login page', async () => {
  probeFailure = new Error('Network Error')   // no `.response`: the server never answered
  renderApp('/library')
  expect((await screen.findByRole('alert')).textContent).toMatch(/Can.t reach the server/)
  expect(screen.queryByLabelText('Username')).toBeNull()
})

it('expiry runs on the SERVER\'s expiresIn: a device clock hours fast does not end a fresh session', async () => {
  // The server says: valid for an hour. This device's clock is two hours ahead, so a timer
  // computed from exp against Date.now() would fire at once and sign the user out.
  const realNowSec = Math.floor(Date.now() / 1000)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 2 * 3600 * 1000)
  try {
    serverSession = 'jane'
    api.get.mockImplementation((url) => (url.endsWith('/auth/session')
      ? Promise.resolve({ data: { session: { ...view('jane'), exp: realNowSec + 3600, expiresIn: 3600 } } })
      : Promise.resolve({ data: [] })))
    renderApp('/library')
    await waitFor(() => expect(heading()).toMatch(/library/i))
    await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
    expect(heading()).toMatch(/library/i)
    expect(getSession()).not.toBeNull()
  } finally { vi.useRealTimers() }
})

it('another tab signing IN: a signed-out tab follows; a tab signed in as someone else reloads', async () => {
  renderApp('/login')
  await screen.findByLabelText('Username')
  serverSession = 'jane'
  const otherTab = new BroadcastChannel('gametracker-session')
  await act(async () => {
    otherTab.postMessage({ type: 'login', username: 'jane' })
    await new Promise((r) => setTimeout(r, 50))
  })
  await waitFor(() => expect(heading()).toMatch(/search/i))
  // Now signed in as jane, and another tab signs in as bob: this page reloads rather than
  // leave jane's data on screen under bob's cookie.
  const reload = vi.fn()
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload })
  await act(async () => {
    otherTab.postMessage({ type: 'login', username: 'bob' })
    await new Promise((r) => setTimeout(r, 50))
  })
  otherTab.close()
  expect(reload).toHaveBeenCalled()
})

it('neither the boot 401 nor another tab\'s sign-out calls the server logout (CISO review)', async () => {
  writeHint({ username: 'jane', exp: Math.floor(Date.now() / 1000) - 60 })
  // Nor does the boot 401 announce a sign-out to other tabs: nothing changed there.
  const heard = []
  const listener = new BroadcastChannel('gametracker-session')
  listener.onmessage = (e) => heard.push(e.data)
  renderApp('/library')
  await screen.findByLabelText('Username')
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  listener.close()
  expect(heard).toEqual([])
  const logouts = () => api.post.mock.calls.filter(([url]) => url.endsWith('/auth/logout')).length
  expect(logouts()).toBe(0)
  cleanup()
  serverSession = 'jane'
  renderApp('/library')
  await waitFor(() => expect(heading()).toMatch(/library/i))
  const otherTab = new BroadcastChannel('gametracker-session')
  await act(async () => {
    otherTab.postMessage({ type: 'logout', username: 'jane' })
    await new Promise((r) => setTimeout(r, 50))
  })
  otherTab.close()
  expect(logouts()).toBe(0)
})
