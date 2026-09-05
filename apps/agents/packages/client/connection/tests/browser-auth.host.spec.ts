/** Agent browser authentication contract. */

import { describe, expect, it } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'

function request(url: string): ConnectionIndexRequest {
  return { method: 'GET', url, headers: { host: '127.0.0.1:3080' } }
}

describe('BrowserAuth', () => {
  it('never generates or requires an Agent token or browser cookie', async () => {
    const auth = await BrowserAuth.create()

    expect(auth.authenticatedUrl('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080/')
    expect(auth.authorizeIndex(request('/?token=unexpected'), {} as ConnectionIndexResponse)).toBe(true)
    expect(auth.authorizeIndex(request('/agent/'), {} as ConnectionIndexResponse)).toBe(true)
    expect(auth.isAuthenticated(request('/api'))).toBe(true)
  })
})
