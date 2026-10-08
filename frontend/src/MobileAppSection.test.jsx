// MOB-40: My Account offers the APK only when the server actually has one. A download
// offered before the first publish would save nginx's 404 page as "gametracker.apk".
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import MobileAppSection, { APK_PATH } from './MobileAppSection'
import { api } from './api'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('offers the download, with its size and date, when the APK is published', async () => {
  const head = vi.spyOn(api, 'head').mockResolvedValue({
    status: 200,
    headers: { 'content-length': String(12.5 * 1024 * 1024), 'last-modified': 'Mon, 28 Sep 2026 10:39:21 GMT' },
  })
  render(<MobileAppSection />)
  const link = await screen.findByRole('link', { name: /Download for Android/ })
  expect(link.getAttribute('href')).toBe('/download/gametracker.apk')
  expect(link.hasAttribute('download')).toBe(true)
  expect(screen.getByText(/12\.5 MB/)).toBeTruthy()
  // The fixed nginx path, never through API_BASE (/api/...): it is not an API call.
  expect(head).toHaveBeenCalledWith(APK_PATH)
  expect(APK_PATH).toBe('/download/gametracker.apk')
})

it('says the app is not published yet, and offers no download, on a 404', async () => {
  vi.spyOn(api, 'head').mockRejectedValue({ response: { status: 404 } })
  render(<MobileAppSection />)
  expect(await screen.findByText(/hasn.t been published on this server yet/)).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
})

it('does not claim "not published" when the check itself failed', async () => {
  vi.spyOn(api, 'head').mockRejectedValue(new Error('Network Error'))
  render(<MobileAppSection />)
  expect(await screen.findByText(/Couldn.t check whether the app is available/)).toBeTruthy()
  expect(screen.queryByText(/hasn.t been published/)).toBeNull()
  expect(screen.getByRole('link', { name: /Try the download anyway/ }).getAttribute('href')).toBe(APK_PATH)
})
