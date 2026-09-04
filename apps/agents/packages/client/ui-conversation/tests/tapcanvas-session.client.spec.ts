// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { syncTapCanvasSession } from '../src/client/apply.ts'

const ROOT = 'repository-session' as SessionId
const CANVAS = 'canvas-session' as SessionId

describe('TapCanvas Agent session binding', () => {
  let runtime: SlotTestRuntime | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
  })

  it('clears a restored repository session before opening the canvas-bound session', async () => {
    runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({
      id: ROOT,
      summary: { cwd: 'F:/aigc/aigc/TapCanvas', blank: true },
    })
    runtime.sessions.stubCreate(async (options) => {
      const cwd = options?.cwd
      if (cwd !== 'F:/canvas-workspaces/abc123') {
        throw new Error(`unexpected canvas cwd: ${String(cwd)}`)
      }
      await runtime!.sessions.add({
        id: CANVAS,
        summary: { cwd, blank: true },
      }, { current: false })
      return CANVAS
    })

    await syncTapCanvasSession(
      runtime.sessions,
      ROOT,
      async () => ({ workspaceKey: 'abc123', workspacePath: 'F:/canvas-workspaces/abc123' }),
    )

    expect(runtime.sessions.calls.map(call => call.method)).toEqual(['clear', 'create', 'open'])
    expect(runtime.sessions.list.getSnapshot().current).toBe(CANVAS)
    expect(runtime.sessions.list.getSnapshot().byId[CANVAS]?.cwd).toBe('F:/canvas-workspaces/abc123')
  })
})
