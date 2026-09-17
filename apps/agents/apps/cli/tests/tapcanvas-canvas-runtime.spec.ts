import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { FILM_FUNCTION_NAMES } from '@deepseek-ai/dsh-web-app/src/tapcanvas-scope.ts'
import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name)

/** Environment names this suite pins for the canvas surface, restored after the boot. */
const PINNED_ENV = [
  'DSH_HOME',
  'DSH_BUNDLED_SKILL_DIR',
  'TAPCANVAS_CANVAS_MODE',
  'TAPCANVAS_WEB_DIST_INDEX',
  'TAPCANVAS_API_PROXY_TARGET',
] as const

let booted: Context | undefined
const previousEnv = new Map<string, string | undefined>()

/** Pin one environment variable, remembering its pre-test value for restoration. */
function pinEnv(name: (typeof PINNED_ENV)[number], value: string): void {
  if (!previousEnv.has(name)) previousEnv.set(name, process.env[name])
  process.env[name] = value
}

/**
 * Restore every pinned variable to its pre-test value, deleting the ones this
 * suite introduced. The pinned values decide profile, skill, and surface
 * resolution for later boots in this worker, so a leak would decide another
 * suite's tree.
 */
function restorePinnedEnv(): void {
  for (const name of PINNED_ENV) {
    const previous = previousEnv.get(name)
    // Named restore, not index assignment: the pin table is the only reason
    // this suite touches the environment at all.
    if (previous === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = previous
  }
}

/**
 * Boot the shipped Web surface with the TapCanvas canvas runtime enabled.
 *
 * The rows that decide an agent's catalog are the real ones — including
 * `webserver`, `connection` and `web-runtime`, which the session-preset e2e
 * disables because it asserts preset composition rather than surface glue. A
 * bound port is required for `connection` to register a route, so this boot
 * takes an OS-assigned port and skips every row that needs a browser or
 * writes outside the temporary home.
 */
async function bootCanvasSurface(): Promise<Context> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tapcanvas-runtime-'))
  const distIndex = join(home, 'dist/index.html')
  await mkdir(dirname(distIndex), { recursive: true })
  await writeFile(distIndex, '<head></head><body>canvas surface</body>\n')
  pinEnv('DSH_HOME', home)
  pinEnv('DSH_BUNDLED_SKILL_DIR', join(REPO_ROOT, '.agents/skills'))
  pinEnv('TAPCANVAS_CANVAS_MODE', '1')
  pinEnv('TAPCANVAS_WEB_DIST_INDEX', distIndex)
  pinEnv('TAPCANVAS_API_PROXY_TARGET', 'http://127.0.0.1:8788')
  const profileDir = join(home, 'profiles/spec')
  await mkdir(profileDir, { recursive: true })
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, home })
  const overrides: PatchOptions[] = [
    { id: 'settings', config: { path: join(home, 'settings.yaml'), watch: false } },
    { id: 'storage-json', config: { root: join(home, 'storages') } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions') } },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'session-log-download', disabled: true },
    { id: 'open-in-app', disabled: true },
    { id: 'directory-picker', disabled: true },
    { id: 'agent-presets', config: { default: 'standard', includeUserRoot: false } },
  ]
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  const patches = [
    ...loadOverlayPatches('dsh-test', BASE_PATCH),
    ...loadOverlayPatches('dsh-test', WEB_PATCH),
    ...overrides,
  ]
  return await boot('dsh-test', rootConfig, patches, (bootCtx) => {
    provideCmdline(bootCtx, { args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], exit: () => {} })
  })
}

describe('TapCanvas 画布运行时挂载', () => {
  afterAll(async () => {
    const root = booted
    await root?.fiber.dispose()
    // The pinned values decide profile, skill, and surface resolution for every
    // later boot in this worker, so a leak would decide another suite's tree.
    restorePinnedEnv()
  })

  it('把画布读写工具挂进 standard 预设的模型工具清单', async () => {
    booted = await bootCanvasSurface()
    const ctx = booted
    const handle = await ctx.agents.create({
      sessionId: SessionId('tapcanvas-canvas-runtime'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      // 画布工具经宿主全局层发布：任何预设的会话都必须能读到它们，
      // 否则模型只能看到预设自带工具，无法读取当前画布。
      expect(toolNames(ctx, handle.agent)).toEqual(expect.arrayContaining([
        'tapcanvas_get_current_canvas',
        ...FILM_FUNCTION_NAMES,
      ]))
    } finally {
      await handle.dispose()
    }
  }, 180_000)
})
