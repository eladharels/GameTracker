// FE-2 as BEHAVIOUR (FE-10 retires the source-text pin that counted `seq !== searchSeq`
// guards). A search whose response arrives after a newer search must change nothing:
// not the results, not the error line, not a price.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SearchPage from './SearchPage'
import { api } from '../api'
import { ToastProvider } from '../contexts/ToastContext'
import { ROUTER_PROPS } from '../routerConfig'

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b }); return { p, resolve, reject } }
const game = (id, name, steamAppId) => ({ id, name, releaseDate: '2020-01-01', coverUrl: null, source: 'igdb', steamAppId })

let routes
beforeEach(() => {
  routes = {}
  vi.spyOn(api, 'get').mockImplementation((url) => {
    for (const [pattern, answer] of Object.entries(routes)) if (url.includes(pattern)) return answer()
    return Promise.resolve({ data: [] })   // the library read and anything else
  })
})
afterEach(cleanup)

function renderSearch() {
  render(
    <MemoryRouter {...ROUTER_PROPS}>
      <ToastProvider><SearchPage user={{ username: 'alice' }} /></ToastProvider>
    </MemoryRouter>,
  )
}
async function searchFor(q) {
  const box = screen.getByLabelText('Search Games')
  fireEvent.change(box, { target: { value: q } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Search' })) })
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('a stale search response changes nothing (FE-2)', () => {
  it('slow results for an OLD query do not replace the newer results', async () => {
    const old = deferred()
    routes['q=zelda'] = () => old.p
    routes['q=hades'] = () => Promise.resolve({ data: [game('igdb_2', 'Hades')] })
    renderSearch()
    await searchFor('zelda')
    await searchFor('hades')
    await flush()
    expect(screen.getAllByText('Hades').length).toBeGreaterThan(0)
    await act(async () => { old.resolve({ data: [game('igdb_1', 'Zelda')] }) })
    await flush()
    expect(screen.queryAllByText('Zelda')).toHaveLength(0)
    expect(screen.getAllByText('Hades').length).toBeGreaterThan(0)
  })

  it('a late FAILURE of an old query shows no error over the newer results', async () => {
    const old = deferred()
    routes['q=zelda'] = () => old.p
    routes['q=hades'] = () => Promise.resolve({ data: [game('igdb_2', 'Hades')] })
    renderSearch()
    await searchFor('zelda')
    await searchFor('hades')
    await flush()
    await act(async () => { old.reject({ response: { status: 502, data: { error: 'Upstream failed' } } }) })
    await flush()
    expect(screen.queryByText('Upstream failed')).toBeNull()
    expect(screen.getAllByText('Hades').length).toBeGreaterThan(0)
  })

  it("an old search's late PRICE does not overwrite the newer search's price", async () => {
    const oldPrice = deferred()
    let priceCalls = 0
    routes['q=hades'] = () => Promise.resolve({ data: [game('igdb_2', 'Hades', '1145360')] })
    routes['game-price/1145360'] = () => (++priceCalls === 1 ? oldPrice.p : Promise.resolve({ data: { price: '$10.00' } }))
    renderSearch()
    await searchFor('hades')        // price request #1 (slow)
    await searchFor('hades')        // price request #2 answers now
    await flush()
    expect(screen.getByText(/\$10\.00/)).toBeTruthy()
    await act(async () => { oldPrice.resolve({ data: { price: '$99.99' } }) })
    await flush()
    expect(screen.queryByText(/\$99\.99/)).toBeNull()
    expect(screen.getByText(/\$10\.00/)).toBeTruthy()
  })

  it("an old search's late price FAILURE does not wipe the newer search's price", async () => {
    const oldPrice = deferred()
    let priceCalls = 0
    routes['q=hades'] = () => Promise.resolve({ data: [game('igdb_2', 'Hades', '1145360')] })
    routes['game-price/1145360'] = () => (++priceCalls === 1 ? oldPrice.p : Promise.resolve({ data: { price: '$10.00' } }))
    renderSearch()
    await searchFor('hades')
    await searchFor('hades')
    await flush()
    await act(async () => { oldPrice.reject(new Error('Steam timeout')) })
    await flush()
    expect(screen.getByText(/\$10\.00/)).toBeTruthy()
  })
})

describe('search results open their details from a title button (FE-6)', () => {
  it('each result has a title BUTTON, and it opens the detail dialog', async () => {
    routes['q=hades'] = () => Promise.resolve({ data: [game('igdb_2', 'Hades')] })
    renderSearch()
    await searchFor('hades')
    await flush()
    const title = screen.getByRole('button', { name: 'Hades' })
    await act(async () => { fireEvent.click(title) })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
