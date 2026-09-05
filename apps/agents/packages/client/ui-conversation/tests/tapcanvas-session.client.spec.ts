// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { syncTapCanvasSession } from '../src/client/apply.ts'

const ROOT = 'repository-session' as SessionId
const CANVAS = 'canvas-session' as SessionId
const HISTORY = 'history-session' as SessionId

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
      if (options?.workspaceId !== 'canvas-workspace') {
        throw new Error(`unexpected canvas workspace: ${String(options?.workspaceId)}`)
      }
      const cwd = 'F:/canvas-workspaces/abc123'
      await runtime!.sessions.add({
        id: CANVAS,
        summary: { cwd, blank: true },
      }, { current: false })
      return CANVAS
    })

    await syncTapCanvasSession(
      runtime.sessions,
      ROOT,
      async () => ({
        workspaceKey: 'abc123',
        workspacePath: 'F:/canvas-workspaces/abc123',
        workspaceId: 'canvas-workspace',
      }),
    )

    expect(runtime.sessions.calls.map(call => call.method)).toEqual(['clear', 'create', 'open'])
    expect(runtime.sessions.list.getSnapshot().current).toBe(CANVAS)
    expect(runtime.sessions.list.getSnapshot().byId[CANVAS]?.cwd).toBe('F:/canvas-workspaces/abc123')
  })

  it('keeps a newly created canvas session current during the follow-up scope sync', async () => {
    runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({
      id: CANVAS,
      summary: { cwd: 'F:/canvas-workspaces/abc123', blank: true },
    })

    await syncTapCanvasSession(
      runtime.sessions,
      CANVAS,
      async () => ({
        workspaceKey: 'abc123',
        workspacePath: 'F:/canvas-workspaces/abc123',
        workspaceId: 'canvas-workspace',
      }),
    )

    expect(runtime.sessions.calls.map(call => call.method)).toEqual([])
    expect(runtime.sessions.list.getSnapshot().current).toBe(CANVAS)
  })

  it('keeps the clicked historical session when it belongs to the current canvas workspace', async () => {
    runtime = await SlotTestRuntime.create()
    await runtime.sessions.add({
      id: CANVAS,
      summary: { cwd: 'F:/canvas-workspaces/abc123', blank: true },
    })
    await runtime.sessions.add({
      id: HISTORY,
      summary: { cwd: 'F:/canvas-workspaces/abc123', blank: false },
    }, { current: false })
    runtime.sessions.open(HISTORY)

    await syncTapCanvasSession(
      runtime.sessions,
      HISTORY,
      async () => ({
        workspaceKey: 'abc123',
        workspacePath: 'F:/canvas-workspaces/abc123',
        workspaceId: 'canvas-workspace',
      }),
    )

    expect(runtime.sessions.list.getSnapshot().current).toBe(HISTORY)
  })

  it('creates a canvas session without requiring a workspace picker when no session is current', async () => {
    runtime = await SlotTestRuntime.create()
    runtime.sessions.stubCreate(async (options) => {
      if (options?.workspaceId !== 'canvas-workspace') {
        throw new Error(`unexpected canvas workspace: ${String(options?.workspaceId)}`)
      }
      await runtime!.sessions.add({
        id: CANVAS,
        summary: { cwd: 'F:/canvas-workspaces/abc123', blank: true },
      }, { current: false })
      return CANVAS
    })

    await syncTapCanvasSession(
      runtime.sessions,
      undefined,
      async () => ({
        workspaceKey: 'abc123',
        workspacePath: 'F:/canvas-workspaces/abc123',
        workspaceId: 'canvas-workspace',
      }),
    )

    expect(runtime.sessions.calls.map(call => call.method)).toEqual(['create', 'open'])
    expect(runtime.sessions.list.getSnapshot().current).toBe(CANVAS)
  })
})
