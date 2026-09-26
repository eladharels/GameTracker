// SEC-14 condition 10(b): an instance running with SESSION_COOKIE_INSECURE=1 says so on the
// page an administrator looks at. The flag arrives on the session view (cookieSecure).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SystemStatusPage from './SystemStatusPage'
import { api } from '../api'
import { sessionFromView, setSession } from '../session'

beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { overall: 'ok', services: [] } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); setSession(null) })

const signIn = (cookieSecure) => setSession(sessionFromView({ username: 'root', can_manage_users: true, expiresIn: 3600, exp: 9e9, cookieSecure }))

it('warns when the session cookie is not Secure', async () => {
  signIn(false)
  render(<SystemStatusPage />)
  expect(await screen.findByText(/SESSION_COOKIE_INSECURE=1/)).toBeTruthy()
})

it('says nothing when the session cookie is Secure (the default)', async () => {
  signIn(true)
  render(<SystemStatusPage />)
  await screen.findByText(/All systems operational|Checking/)
  expect(screen.queryByText(/SESSION_COOKIE_INSECURE=1/)).toBeNull()
})
