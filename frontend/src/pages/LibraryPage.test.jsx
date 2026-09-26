// FE-1, FE-5 and FE-6 as BEHAVIOUR (FE-10 retires the source-text pins in
// test/runtime.test.js that read these fixes' shape out of App.jsx).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LibraryPage from './LibraryPage'
import { api } from '../api'
import { ToastProvider } from '../contexts/ToastContext'
import { ROUTER_PROPS } from '../routerConfig'

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b }); return { p, resolve, reject } }
const row = (id, name, status, extra = {}) => ({
  game_id: id, game_name: name, cover_url: null, release_date: '2020-01-01', status, ...extra,
})

let library, posts, puts, postAnswer
beforeEach(() => {
  library = [row('igdb_1', 'Alpha', 'wishlist'), row('igdb_2', 'Bravo', 'wishlist')]
  posts = []
  puts = []
  postAnswer = () => Promise.resolve({ data: { success: true } })
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (/\/user\/alice\/games\?t=/.test(url)) return Promise.resolve({ data: library })
    return Promise.resolve({ data: [] })   // stats, history, anything else
  })
  vi.spyOn(api, 'post').mockImplementation((url, body) => { posts.push({ url, body }); return postAnswer(url, body) })
  vi.spyOn(api, 'put').mockImplementation((url, body) => { puts.push({ url, body }); return Promise.resolve({ data: {} }) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
async function renderLibrary() {
  render(
    <MemoryRouter {...ROUTER_PROPS}>
      <ToastProvider><LibraryPage user={{ username: 'alice' }} /></ToastProvider>
    </MemoryRouter>,
  )
  await flush()
}
const crackPosts = () => posts.filter((p) => p.url.includes('crackrelease-status'))
const toggleCrack = () => act(async () => {
  fireEvent.click(screen.getByRole('button', { name: /crack status/i }))
})
const statusOf = (name) => screen.getByRole('combobox', { name: `Status for ${name}` })
const setStatus = (name, value) => act(async () => { fireEvent.change(statusOf(name), { target: { value } }) })

describe('crack-status checks (FE-1, SEC-15)', () => {
  it('sends ONE request per game however often the page re-renders or the toggle flips', async () => {
    const pending = []
    postAnswer = (url) => { if (url.includes('crackrelease')) { const d = deferred(); pending.push(d); return d.p } return Promise.resolve({ data: {} }) }
    await renderLibrary()
    await toggleCrack()
    expect(crackPosts()).toHaveLength(2)
    // Re-render repeatedly while both are in flight: switch views, flip the toggle.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'List view' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Grid view' })) })
    await toggleCrack()
    await toggleCrack()
    expect(crackPosts()).toHaveLength(2)
    await act(async () => { pending.forEach((d) => d.resolve({ data: { status: 'cracked' } })) })
    await flush()
    await toggleCrack()
    await toggleCrack()
    expect(crackPosts()).toHaveLength(2)   // answered: nothing left to ask
  })

  it('a 429 is "not now": nothing is re-sent before Retry-After has passed', async () => {
    postAnswer = (url) => url.includes('crackrelease')
      ? Promise.reject({ response: { status: 429, headers: { 'retry-after': '120' } } })
      : Promise.resolve({ data: {} })
    await renderLibrary()
    await toggleCrack()
    await flush()
    expect(crackPosts()).toHaveLength(2)
    await toggleCrack()
    await toggleCrack()
    await flush()
    expect(crackPosts()).toHaveLength(2)
  })
})

describe('a failed status change rolls back only itself (FE-5)', () => {
  it("one game's failure does not undo another game's change made meanwhile", async () => {
    const alphaWrite = deferred()
    postAnswer = (url, body) => (body?.gameId === 'igdb_1' ? alphaWrite.p : Promise.resolve({ data: {} }))
    await renderLibrary()
    await setStatus('Alpha', 'playing')
    await setStatus('Bravo', 'done')
    await flush()
    await act(async () => { alphaWrite.reject(new Error('500')) })
    await flush()
    expect(statusOf('Alpha').value).toBe('wishlist')   // its own change, rolled back
    expect(statusOf('Bravo').value).toBe('done')       // not a whole-library snapshot restore
  })

  it('a late failure does not undo a NEWER change to the same game', async () => {
    const first = deferred()
    let n = 0
    postAnswer = (url, body) => (body?.gameId === 'igdb_1' && ++n === 1 ? first.p : Promise.resolve({ data: {} }))
    await renderLibrary()
    await setStatus('Alpha', 'playing')   // request 1, slow
    await setStatus('Alpha', 'done')      // request 2, succeeds
    await flush()
    await act(async () => { first.reject(new Error('500')) })
    await flush()
    expect(statusOf('Alpha').value).toBe('done')
  })
})

describe('library cards and chips are reachable and named (FE-6)', () => {
  it('the six status chips are toggle buttons, and pressing one filters the list', async () => {
    library = [row('igdb_1', 'Alpha', 'wishlist'), row('igdb_2', 'Bravo', 'done')]
    await renderLibrary()
    const chips = screen.getAllByRole('button', { name: /show only these|show all games/ })
    expect(chips).toHaveLength(6)
    for (const c of chips) expect(c.getAttribute('aria-pressed')).toMatch(/^(true|false)$/)
    const done = screen.getByRole('button', { name: 'Done: 1 — show only these' })
    await act(async () => { fireEvent.click(done) })
    expect(done.getAttribute('aria-pressed')).toBe('true')
    const list = screen.getByRole('region', { name: 'Your games' })
    expect(within(list).queryByRole('group', { name: 'Alpha' })).toBeNull()
    expect(within(list).getByRole('group', { name: 'Bravo' })).toBeTruthy()
  })

  it('each card is a group named by its title; the title button opens the details', async () => {
    await renderLibrary()
    const card = screen.getByRole('group', { name: 'Alpha' })
    expect(card.hasAttribute('aria-label')).toBe(false)   // the invalid role-less aria-label
    for (const name of ['Status for Alpha', 'Refresh metadata for Alpha', 'Remove Alpha']) {
      expect(within(card).getByLabelText(name)).toBeTruthy()
    }
    expect(card.hasAttribute('tabindex')).toBe(false)     // not a tab stop outside the backlog
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Alpha' })) })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('in the backlog a card is focusable, and Escape from a control inside it drops a held card', async () => {
    library = [row('igdb_1', 'Alpha', 'backlog', { backlog_order: 1 }), row('igdb_2', 'Bravo', 'backlog', { backlog_order: 2 })]
    await renderLibrary()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Backlog: 2/ })) })
    const card = screen.getByRole('group', { name: 'Alpha' })
    expect(card.getAttribute('tabindex')).toBe('0')
    await act(async () => { fireEvent.keyDown(card, { key: 'Enter' }) })
    expect(card.className).toContain('card-keyboard-selected')
    // Escape from the status select, not the card itself.
    await act(async () => { fireEvent.keyDown(within(card).getByLabelText('Status for Alpha'), { key: 'Escape' }) })
    expect(card.className).not.toContain('card-keyboard-selected')
    // Enter on a control inside the card does that control's job, not a pick-up.
    await act(async () => { fireEvent.keyDown(within(card).getByRole('button', { name: 'Alpha' }), { key: 'Enter' }) })
    expect(card.className).not.toContain('card-keyboard-selected')
  })
})
