import { request as httpRequest, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

const TAPCANVAS_API_PROXY_PREFIX = '/tapcanvas-api'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function copyHeaders(headers: IncomingHttpHeaders, omitHost: boolean): IncomingHttpHeaders {
  const copied: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue
    if (omitHost && name.toLowerCase() === 'host') continue
    copied[name] = value
  }
  return copied
}

function parseTarget(rawTarget: string): URL {
  let target: URL
  try {
    target = new URL(rawTarget)
  } catch {
    throw new Error('TAPCANVAS_API_PROXY_TARGET 必须是合法的 http/https URL')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('TAPCANVAS_API_PROXY_TARGET 仅支持 http/https URL')
  }
  return target
}

function requestPath(request: IncomingMessage): string {
  const source = new URL(request.url ?? '/', 'http://tapcanvas.local')
  if (source.pathname !== TAPCANVAS_API_PROXY_PREFIX
    && !source.pathname.startsWith(`${TAPCANVAS_API_PROXY_PREFIX}/`)) {
    throw new Error('TapCanvas API 代理收到无效路径')
  }
  const pathname = source.pathname === TAPCANVAS_API_PROXY_PREFIX
    ? '/'
    : source.pathname.slice(TAPCANVAS_API_PROXY_PREFIX.length)
  return `${pathname}${source.search}`
}

function writeProxyError(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: 'TapCanvas API 代理无法连接到本地 8788 服务' }))
}

/**
 * Mount the local business API behind the Harness origin. Browser extensions
 * may block loopback cross-port XHR; keeping this route same-origin avoids
 * that transport policy while Hono remains the auth and API boundary.
 */
export function mountTapCanvasApiProxy(
  ctx: Context,
  webServer: WebServer,
  rawTarget: string | undefined,
): void {
  if (!rawTarget?.trim()) return
  const target = parseTarget(rawTarget.trim())

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: TAPCANVAS_API_PROXY_PREFIX,
    handler: async (request, response) => {
      const downstreamPath = requestPath(request)
      const options = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: request.method,
        path: `${target.pathname.replace(/\/$/, '')}${downstreamPath}`,
        headers: copyHeaders(request.headers, true),
      }
      const createRequest = target.protocol === 'https:' ? httpsRequest : httpRequest
      const proxyRequest = createRequest(options, (proxyResponse) => {
        response.writeHead(proxyResponse.statusCode ?? 502, copyHeaders(proxyResponse.headers, false))
        proxyResponse.pipe(response)
      })
      proxyRequest.once('error', () => writeProxyError(response))
      request.pipe(proxyRequest)
    },
  }), 'tapcanvas-api-proxy')
}

