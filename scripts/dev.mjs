import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const harnessDirectory = resolve(rootDirectory, 'apps/agents')
const harnessWebDistIndex = resolve(harnessDirectory, 'apps/web/dist/index.html')
const tapCanvasWebDistIndex = resolve(rootDirectory, 'apps/web/dist/index.html')
// 新 Harness 运行时不能复用迁移前 Bridge 的持久化目录：两者的会话 schema
// 和身份边界不同，混用时必须显式失败，而不是在启动时迁移或覆盖旧记录。
const harnessHomeDirectory = resolve(rootDirectory, '.runtime/tapcanvas-agents-web')
const harnessAuthenticatedUrlFile = resolve(harnessHomeDirectory, 'authenticated-url.txt')
const harnessWebUrl = 'http://127.0.0.1:3080'
const command = process.argv[2] || 'local'
const options = new Set(process.argv.slice(3))
const isWindows = process.platform === 'win32'
const pnpmCommand = 'corepack'
const npmCommand = isWindows ? 'npm.cmd' : 'npm'
const services = []
let stopping = false

function runBlocking(program, args, cwd, env = process.env) {
  const spec = toProcessSpec(program, args)
  const result = spawnSync(spec.program, spec.args, { cwd, env, stdio: 'inherit', windowsHide: false })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function startService(name, program, args, cwd, env = process.env) {
  const spec = toProcessSpec(program, args)
  const child = spawn(spec.program, spec.args, { cwd, env, stdio: 'inherit', windowsHide: false })
  child.once('error', (error) => {
    console.error(`[dev] ${name} 启动失败：${error.message}`)
  })
  child.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`[dev] ${name} 已退出：${signal || `exit ${code ?? 1}`}`)
    }
  })
  services.push(child)
  return child
}

function startHarnessWebService(env) {
  mkdirSync(harnessHomeDirectory, { recursive: true })
  const spec = toProcessSpec(pnpmCommand, [
    'pnpm', '--dir', harnessDirectory, 'run', 'dsh', 'web', '--host', '127.0.0.1', '--port', '3080',
  ])
  const child = spawn(spec.program, spec.args, {
    cwd: rootDirectory,
    env,
    stdio: ['inherit', 'pipe', 'inherit'],
    windowsHide: false,
  })
  let settled = false
  let output = ''
  const authenticatedUrl = new Promise((resolveResult, rejectResult) => {
    const resolveUrl = (url) => {
      if (settled) return
      settled = true
      try {
        writeFileSync(harnessAuthenticatedUrlFile, `${url}\n`, 'utf8')
      } catch (error) {
        rejectResult(error)
        return
      }
      resolveResult(url)
    }
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      process.stdout.write(text)
      output += text
      const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:3080\/\?token=[^\s)]+)/u)
      if (match?.[1]) resolveUrl(match[1])
      if (output.length > 20_000) output = output.slice(-10_000)
    })
    child.once('error', (error) => {
      if (!settled) rejectResult(error)
      console.error(`[dev] harness-web 启动失败：${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (!stopping && code !== 0) {
        console.error(`[dev] harness-web 已退出：${signal || `exit ${code ?? 1}`}`)
      }
      if (!settled) rejectResult(new Error(`Harness Web 未打印认证 URL（${signal || `exit ${code ?? 1}`}）`))
    })
  })
  services.push(child)
  return { child, authenticatedUrl }
}

function toProcessSpec(program, args) {
  if (!isWindows) return { program, args }
  const commandLine = [program, ...args].map((value) => String(value)).join(' ')
  return {
    program: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
  }
}

function stopServices() {
  if (stopping) return
  stopping = true
  for (const child of services) {
    if (!child.killed) child.kill('SIGTERM')
  }
}

async function isNewApiHealthy(baseUrl) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(`${baseUrl}/api/status`, { signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json()
    return isRecord(body) && body.success === true && isRecord(body.data)
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function isHonoApiHealthy(baseUrl) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(`${baseUrl}/health/ready`, { signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json()
    return isRecord(body)
      && body.ok === true
      && body.service === 'tapcanvas-hono-api'
      && isRecord(body.lifecycle)
      && body.lifecycle.ready === true
      && body.lifecycle.draining === false
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForHonoApiReady(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isHonoApiHealthy(baseUrl)) return true
    await new Promise((resolveResult) => setTimeout(resolveResult, 250))
  }
  return false
}

function isRecord(value) {
  return typeof value === 'object' && value !== null
}

function readHarnessAuthenticatedUrl() {
  try {
    const value = readFileSync(harnessAuthenticatedUrlFile, 'utf8').trim()
    const parsed = new URL(value)
    if (parsed.origin !== harnessWebUrl || parsed.pathname !== '/' || !parsed.searchParams.get('token')) return null
    return parsed.href
  } catch {
    return null
  }
}

function isTcpPortOpen(host, port) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host, port })
    const finish = (open) => {
      socket.destroy()
      resolveResult(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

function getListeningProcessIds(port) {
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0 || !result.stdout) return []

  const processIds = new Set()
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue
    if (!fields[1].endsWith(`:${port}`) || fields[3].toUpperCase() !== 'LISTENING') continue
    const processId = Number(fields[4])
    if (Number.isInteger(processId) && processId > 0) processIds.add(processId)
  }
  return [...processIds]
}

function getProcessCommandLine(processId) {
  if (isWindows) {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${processId}\").CommandLine`,
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    return result.status === 0 ? result.stdout.trim() : ''
  }

  const result = spawnSync('ps', ['-p', String(processId), '-o', 'command='], {
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

function isTapCanvasWebViteProcess(commandLine) {
  const normalizedCommandLine = commandLine.toLowerCase().replaceAll('/', '\\')
  const normalizedRoot = rootDirectory.toLowerCase().replaceAll('/', '\\')
  return (
    normalizedCommandLine.includes(`${normalizedRoot}\\apps\\web\\`) &&
    normalizedCommandLine.includes('vite')
  )
}

function stopProcessTree(processId) {
  if (isWindows) {
    const result = spawnSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return result.status === 0
  }

  try {
    process.kill(processId, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

function stopStaleWebDevServers() {
  const ports = [5175, 5176]
  for (const port of ports) {
    for (const processId of getListeningProcessIds(port)) {
      if (processId === process.pid) continue
      const commandLine = getProcessCommandLine(processId)
      if (!isTapCanvasWebViteProcess(commandLine)) continue
      if (stopProcessTree(processId)) {
        console.log(`[dev] 已关闭旧 Web Vite 进程：PID ${processId}（端口 ${port}）`)
      } else {
        console.warn(`[dev] 无法关闭旧 Web Vite 进程：PID ${processId}（端口 ${port}）`)
      }
    }
  }
}

function isHarnessWebProcess(commandLine) {
  const normalizedCommandLine = commandLine.toLowerCase().replaceAll('/', '\\')
  const usesHarnessCli = normalizedCommandLine.includes('apps\\agents\\apps\\cli\\src\\bin.ts')
    || normalizedCommandLine.includes('apps\\cli\\src\\bin.ts')
  return usesHarnessCli
    && normalizedCommandLine.includes('"web"')
    && normalizedCommandLine.includes('"--port" "3080"')
}

async function isHarnessWebHealthy() {
  const processIds = getListeningProcessIds(3080)
  for (const processId of processIds) {
    if (!isHarnessWebProcess(getProcessCommandLine(processId))) continue
    // The Harness root is intentionally protected; a 401 here is the expected
    // response before the browser exchanges its launch token for a cookie.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    try {
      const response = await fetch(harnessWebUrl, { signal: controller.signal })
      if (response.status === 401 || response.status === 200) return true
    } catch {
      // The process may still be binding; the port/process identity remains the
      // authoritative ownership signal for a managed local Harness instance.
    } finally {
      clearTimeout(timeout)
    }
  }
  return false
}

async function prepareHarnessWeb() {
  const distEntry = harnessWebDistIndex
  const cliSourceEntry = resolve(harnessDirectory, 'apps/cli/src/bin.ts')
  // Harness serves the static TapCanvas bundle before the watch build can
  // settle. Always build the entry first so an older bundle cannot send API
  // requests to the wrong origin during startup.
  console.log(`[dev] 构建 Harness Agent 前端与 TapCanvas 静态入口：${existsSync(distEntry) ? '刷新现有产物' : '产物缺失'}`)
  runBlocking(pnpmCommand, ['pnpm', '--dir', harnessDirectory, 'run', 'build:web'], rootDirectory)
  if (!existsSync(cliSourceEntry)) {
    throw new Error('[dev] apps/agents/apps/cli/src/bin.ts 缺失，无法启动统一 Harness Web。')
  }
  console.log(`[dev] 构建 TapCanvas 静态入口：${existsSync(tapCanvasWebDistIndex) ? '刷新现有产物' : '产物缺失'}`)
  runBlocking(
    pnpmCommand,
    ['pnpm', 'run', 'build:web'],
    rootDirectory,
    // Harness 的同源 TapCanvas 业务 API 代理挂在 /tapcanvas-api；/api
    // 由 Harness 自身占用，不能写入 TapCanvas 前端产物。
    {
      ...process.env,
      VITE_API_BASE: process.env.VITE_API_BASE || '/tapcanvas-api',
      ALLOW_LOCALHOST_IN_PROD_BUILD: process.env.ALLOW_LOCALHOST_IN_PROD_BUILD || '1',
    },
  )

  if (await isHarnessWebHealthy()) {
    console.log(`[dev] 检测到已运行的 Harness Web，复用：${harnessWebUrl}`)
    return false
  }

  if (await isTcpPortOpen('127.0.0.1', 3080)) {
    throw new Error(
      '[dev] 端口 3080 已被占用，但占用服务不是可识别的 Harness Web；请关闭占用进程后重试。',
    )
  }

  return true
}

async function prepareNewApi() {
  const baseUrl = 'http://127.0.0.1:4455'
  if (await isNewApiHealthy(baseUrl)) {
    console.log(`[dev] 检测到已运行的 new-api，复用：${baseUrl}`)
    return false
  }

  if (await isTcpPortOpen('127.0.0.1', 4455)) {
    throw new Error(
      '[dev] 端口 4455 已被占用，但占用服务不是可识别的 new-api；请关闭占用进程后重试。',
    )
  }

  return true
}

async function prepareHonoApi() {
  const baseUrl = 'http://127.0.0.1:8788'
  if (await isHonoApiHealthy(baseUrl)) {
    console.log(`[dev] 检测到已运行的 TapCanvas API，复用：${baseUrl}`)
    return false
  }

  if (await isTcpPortOpen('127.0.0.1', 8788)) {
    throw new Error(
      '[dev] 端口 8788 已被占用，但占用服务不是可识别的 TapCanvas API；请关闭占用进程后重试。',
    )
  }

  return true
}

if (command === 'help' || command === '--help' || command === '-h') {
  console.log('用法：pnpm run dev [-- --install]')
  process.exit(0)
}

if (command !== 'local') {
  console.error(`[dev] 不支持的启动模式：${command}`)
  process.exit(1)
}

if (options.has('--install')) {
  runBlocking(pnpmCommand, ['pnpm', '-w', 'install'], rootDirectory)
}

const newApiWebDirectory = resolve(rootDirectory, 'apps/new-api/web')
const newApiDistEntry = resolve(newApiWebDirectory, 'dist/index.html')
if (!existsSync(newApiDistEntry)) {
  console.log('[dev] new-api 前端产物缺失，先构建嵌入式控制台...')
  runBlocking(npmCommand, ['run', 'build'], newApiWebDirectory)
}

const shouldStartHonoApi = await prepareHonoApi()
const shouldStartNewApi = await prepareNewApi()
const shouldStartHarnessWeb = await prepareHarnessWeb()
if (!shouldStartHarnessWeb && readHarnessAuthenticatedUrl() === null) {
  console.warn('[dev] 已复用运行中的 Harness Web，但没有找到认证 URL；无法自动完成本地登录交换。')
}
stopStaleWebDevServers()

const honoDirectory = resolve(rootDirectory, 'apps/hono-api')
const honoEnvironment = {
  ...process.env,
  NODE_PATH: [resolve(honoDirectory, 'node_modules'), process.env.NODE_PATH || '']
    .filter(Boolean)
    .join(delimiter),
  // The unified Harness Web owns /api for its RPC transport. Keep the
  // TapCanvas business API on its actual local origin so login and all other
  // browser requests do not get intercepted by Harness.
  CORS_ALLOWED_ORIGINS: [
    process.env.CORS_ALLOWED_ORIGINS,
    'http://127.0.0.1:3080',
    'http://localhost:3080',
  ].filter((value) => typeof value === 'string' && value.trim()).join(','),
}

if (shouldStartHonoApi) {
  startService('hono-api', pnpmCommand, ['pnpm', '--filter', '@tapcanvas/api', 'dev'], rootDirectory, honoEnvironment)
  console.log('[dev] TapCanvas API: http://localhost:8788')
  const honoReady = await waitForHonoApiReady('http://127.0.0.1:8788')
  if (!honoReady) {
    stopServices()
    throw new Error('[dev] TapCanvas API 在 30 秒内未达到 ready 状态，已停止本次开发启动。')
  }
  console.log('[dev] TapCanvas API 已 ready，继续启动 Web')
}
if (shouldStartNewApi) {
  startService('new-api', 'go', ['run', 'main.go'], resolve(rootDirectory, 'apps/new-api'))
  console.log('[dev] new-api: http://localhost:4455')
}
if (shouldStartHarnessWeb) {
  const harnessWebEnvironment = {
    ...process.env,
    DSH_HOME: harnessHomeDirectory,
    // Harness 是唯一浏览器入口：根路径托管 TapCanvas，/agent/ 承载原生 Agent UI。
    TAPCANVAS_WEB_DIST_INDEX: tapCanvasWebDistIndex,
    // Browsers or extensions can block loopback cross-port XHR. Keep the
    // business API behind the authenticated Harness origin in this local mode.
    TAPCANVAS_API_PROXY_TARGET: process.env.TAPCANVAS_API_PROXY_TARGET || 'http://127.0.0.1:8788',
  }
  const harnessService = startHarnessWebService(harnessWebEnvironment)
  await harnessService.authenticatedUrl
  console.log('[dev] TapCanvas 统一入口由 Harness 自动打开，认证完成后停留在 http://127.0.0.1:3080/')
}

if (options.has('--webcut')) {
  const webcutDirectory = resolve(rootDirectory, 'apps/webcut-main')
  if (existsSync(resolve(webcutDirectory, 'package.json'))) {
    startService('webcut', pnpmCommand, ['pnpm', 'dev:app', '--host', '0.0.0.0', '--port', '5174'], webcutDirectory)
  } else {
    console.warn('[dev] 未找到 apps/webcut-main，跳过 webcut')
  }
}

const webEnvironment = {
  ...process.env,
  // 构建产物由 Harness Web 托管；TapCanvas 通过 Harness 同源代理访问业务后端。
  VITE_API_BASE: process.env.VITE_API_BASE || '/tapcanvas-api',
  // 本地统一入口使用 production build；允许开发环境的本地 OAuth 回调地址。
  ALLOW_LOCALHOST_IN_PROD_BUILD: process.env.ALLOW_LOCALHOST_IN_PROD_BUILD || '1',
}
startService('web-build-watch', pnpmCommand, ['pnpm', 'run', 'dev:web'], rootDirectory, webEnvironment)
console.log('[dev] TapCanvas 主页面由 Harness Web 同源提供；小 T 在当前页面内打开。')

process.once('SIGINT', stopServices)
process.once('SIGTERM', stopServices)
await new Promise(() => {})
