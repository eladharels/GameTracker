// FE-14 through the REAL route table (review of FE-22). LoginPage.test.jsx routes '*' to a
// location probe, so it could not see the signed-in catch-all <Navigate to="/search"/>
// overtaking the return path — which is exactly what React Router 7's default transitions
// did. This renders App itself, with the router props main.jsx ships.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { api } from './api'
import { markSessionEnded } from './session'
import { ToastProvider } from './contexts/ToastContext'
import { ROUTER_PROPS } from './routerConfig'

const b64url = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwt = (p) => ['x', b64url(JSON.stringify(p)), 'sig'].join('.')

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(cleanup)

function renderApp() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/login']} {...ROUTER_PROPS}>
        <ToastProvider><App /></ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  )
}
async function signIn(username) {
  vi.spyOn(api, 'post').mockResolvedValue({ data: { token: jwt({ id: 1, username, exp: Date.now() / 1000 + 3600 }) } })
  vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } })
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
