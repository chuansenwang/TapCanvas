/** Static-host authorization hook retained for the Connection contract. */

import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'
/**
 * Browser authentication was intentionally removed from the native Agent Web
 * surface. Host/Origin trust remains enforced by the Connection service.
 */
export class BrowserAuth {
  private constructor() {}

  /** Retain the old factory shape while making browser authentication a no-op. */
  static async create(
    _processOwner?: object,
    _credentials?: unknown,
    _maxAgeDays?: number,
  ): Promise<BrowserAuth> {
    return new BrowserAuth()
  }

  /** Return the clean Web application root URL. */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.href
  }

  /** Allow the static host to serve the requested index entry. */
  authorizeIndex(_req: ConnectionIndexRequest, _res: ConnectionIndexResponse): boolean {
    return true
  }

  /** Retained transport hook; Agent Web has no browser-session gate. */
  isAuthenticated(_request: ConnectionTrustRequest): boolean {
    return true
  }
}
