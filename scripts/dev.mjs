import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
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

const honoDirectory = resolve(rootDirectory, 'apps/hono-api')
const honoEnvironment = {
  ...process.env,
  NODE_PATH: [resolve(honoDirectory, 'node_modules'), process.env.NODE_PATH || '']
    .filter(Boolean)
    .join(delimiter),
}

startService('hono-api', pnpmCommand, ['pnpm', '--filter', '@tapcanvas/api', 'dev'], rootDirectory, honoEnvironment)
startService('new-api', 'go', ['run', 'main.go'], resolve(rootDirectory, 'apps/new-api'))

if (options.has('--webcut')) {
  const webcutDirectory = resolve(rootDirectory, 'apps/webcut-main')
  if (existsSync(resolve(webcutDirectory, 'package.json'))) {
    startService('webcut', pnpmCommand, ['pnpm', 'dev:app', '--host', '0.0.0.0', '--port', '5174'], webcutDirectory)
  } else {
    console.warn('[dev] 未找到 apps/webcut-main，跳过 webcut')
  }
}

startService('web', pnpmCommand, ['pnpm', '--filter', '@tapcanvas/web', 'dev'], rootDirectory)
console.log('[dev] new-api: http://localhost:4455')

process.once('SIGINT', stopServices)
process.once('SIGTERM', stopServices)
await new Promise(() => {})
