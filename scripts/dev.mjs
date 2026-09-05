import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
    'pnpm', '--dir', harnessDirectory, 'run', 'dsh', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open',
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
      const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:3080\/)/u)
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
    if (parsed.origin !== harnessWebUrl || parsed.pathname !== '/' || parsed.hash !== '') return null
    return parsed.href
  } catch {
    return null
  }
}

function getProcessStartTime(processId) {
  if (isWindows) {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${processId}\").CreationDate.ToFileTimeUtc()`,
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    const fileTime = Number(result.stdout?.trim())
    if (result.status === 0 && Number.isFinite(fileTime) && fileTime > 0) {
      return fileTime / 10_000 - 11644473600000
    }
    return null
  }

  const result = spawnSync('ps', ['-p', String(processId), '-o', 'lstart='], {
    encoding: 'utf8',
  })
  const timestamp = Date.parse(result.stdout?.trim() || '')
  return result.status === 0 && Number.isFinite(timestamp) ? timestamp : null
}

function isHarnessAuthenticatedUrlFresh(processId) {
  try {
    const processStartTime = getProcessStartTime(processId)
    if (processStartTime === null) return false
    // The URL file is written immediately after the Harness prints its URL.
    // A file older than the listening process therefore belongs to a previous
    // activation.
    return statSync(harnessAuthenticatedUrlFile).mtimeMs >= processStartTime - 2_000
  } catch {
    return false
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
    // A managed local Harness Web process is identified by its process and port.
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
  // Harness 自身仍然使用静态前端；主 TapCanvas 页面由下方的 Vite
  // 开发服务器提供，因此这里不再构建 apps/web 的生产产物。
  if (!existsSync(distEntry)) {
    console.log('[dev] Harness Agent 前端产物缺失，先构建 Harness Web...')
    runBlocking(pnpmCommand, ['pnpm', '--dir', harnessDirectory, 'run', 'build:web'], rootDirectory)
  }
  if (!existsSync(cliSourceEntry)) {
    throw new Error('[dev] apps/agents/apps/cli/src/bin.ts 缺失，无法启动统一 Harness Web。')
  }
  if (await isHarnessWebHealthy()) {
    const authenticatedUrl = readHarnessAuthenticatedUrl()
    const harnessProcessId = getListeningProcessIds(3080).find((processId) =>
      isHarnessWebProcess(getProcessCommandLine(processId)),
    )
    if (authenticatedUrl !== null && new URL(authenticatedUrl).searchParams.size === 0
      && harnessProcessId !== undefined
      && isHarnessAuthenticatedUrlFresh(harnessProcessId)) {
      console.log(`[dev] 检测到已运行的 Harness Web，复用：${harnessWebUrl}`)
      return false
    }

    // The port is owned by our Harness process, but the persisted launch URL
    // is stale (usually after parallel `pnpm dev` runs). Restart only the
    // recognized Harness owner so a fresh clean URL can be issued.
    for (const processId of getListeningProcessIds(3080)) {
      if (!isHarnessWebProcess(getProcessCommandLine(processId))) continue
      if (!stopProcessTree(processId)) {
        throw new Error('[dev] Harness Web 认证 URL 已失效，且无法重启占用 3080 的 Harness 进程。')
      }
      console.log(`[dev] 已重启认证失效的 Harness Web：PID ${processId}`)
    }
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
let harnessLaunchUrl = shouldStartHarnessWeb ? harnessWebUrl : readHarnessAuthenticatedUrl()
if (!shouldStartHarnessWeb && harnessLaunchUrl === null) {
  console.warn('[dev] 已复用运行中的 Harness Web，但没有找到认证 URL；请重启 Harness Web 后再从小 T 打开原生 Agent。')
  harnessLaunchUrl = ''
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
    // Harness 注册 /agent/ 嵌入路由所需的静态入口；开发主页面仍由 5175
    // 的 Vite dev server 提供，这里只保留 Agent iframe 的路由能力。
    TAPCANVAS_CANVAS_MODE: '1',
    TAPCANVAS_WEB_DIST_INDEX: tapCanvasWebDistIndex,
    // Browsers or extensions can block loopback cross-port XHR. Keep the
    // business API behind the authenticated Harness origin in this local mode.
    TAPCANVAS_API_PROXY_TARGET: process.env.TAPCANVAS_API_PROXY_TARGET || 'http://127.0.0.1:8788',
  }
  const harnessService = startHarnessWebService(harnessWebEnvironment)
  harnessLaunchUrl = await harnessService.authenticatedUrl
  console.log(`[dev] Harness Web: ${harnessLaunchUrl}`)
}

// Agent 页面由 Harness 的静态 Web shell 托管。dev-web watcher 负责重编译
// Agent 客户端 bundle，Harness 内置的 HMR 接收器会在 bundle 变更后刷新已
// 打开的 Agent iframe，因此修改 apps/agents 代码无需手动重新构建。
startService(
  'harness-web-watch',
  pnpmCommand,
  ['pnpm', '--dir', harnessDirectory, 'run', 'dev:web'],
  rootDirectory,
)

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
  // 主页面由 TapCanvas 自己的 Vite 开发服务提供，使用同源 /api 代理访问 API。
  VITE_API_BASE: process.env.VITE_API_BASE || '/api',
  VITE_HARNESS_WEB_URL: harnessLaunchUrl,
}
startService(
  'tapcanvas-web',
  pnpmCommand,
  ['pnpm', '--filter', '@tapcanvas/web', 'dev', '--host', '127.0.0.1', '--port', '5175'],
  rootDirectory,
  webEnvironment,
)
console.log('[dev] TapCanvas 主页面: http://127.0.0.1:5175')
console.log('[dev] 点击主页面右下角小 T 进入 Agent 页面')

process.once('SIGINT', stopServices)
process.once('SIGTERM', stopServices)
await new Promise(() => {})
