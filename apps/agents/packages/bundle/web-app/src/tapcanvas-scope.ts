import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { defineTool } from '@deepseek-ai/dsh-tools'

export interface TapCanvasScope {
  readonly projectId: string | null
  readonly projectName: string | null
  readonly flowId: string | null
  readonly chapterId: string | null
  readonly chapterTitle: string | null
  readonly bookId: string | null
  readonly selectedNodeIds: readonly string[]
  readonly canvas: TapCanvasCanvasSnapshot | null
}

export interface TapCanvasCanvasSnapshot {
  readonly nodes: readonly TapCanvasNodeSnapshot[]
  readonly edges: readonly TapCanvasEdgeSnapshot[]
}

export interface TapCanvasNodeSnapshot {
  readonly id: string
  readonly type: string | null
  readonly position: { readonly x: number; readonly y: number }
  readonly data: Record<string, unknown>
}

export interface TapCanvasEdgeSnapshot {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sourceHandle: string | null
  readonly targetHandle: string | null
}

interface ScopeRecord {
  readonly sessionId: string
  readonly scope: TapCanvasScope
}

const scopes = new Map<string, TapCanvasScope>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseScope(value: unknown): ScopeRecord | null {
  if (!isRecord(value) || !isRecord(value.args)) return null
  const sessionId = typeof value.args.sessionId === 'string' ? value.args.sessionId.trim() : ''
  const rawScope = value.args.scope
  if (!sessionId || !isRecord(rawScope)) return null
  const projectId = typeof rawScope.projectId === 'string' ? rawScope.projectId.trim() : ''
  if (!projectId && typeof rawScope.flowId !== 'string' && !isRecord(rawScope.canvas)) return null
  return {
    sessionId,
    scope: rawScope as unknown as TapCanvasScope,
  }
}

function scopeForAgent(agent: unknown): TapCanvasScope | null {
  if (!isRecord(agent) || typeof agent.id !== 'string') return null
  return scopes.get(agent.id) ?? null
}

function success(value: unknown): ConnectionRpcResult<unknown> { return { ok: true, value } }
function failure(code: string, message: string, details: object = {}): ConnectionRpcResult<unknown> {
  return { ok: false, error: { code, message, details } }
}

export function registerTapCanvasRuntime(ctx: Context): void {
  ctx.connection.rpc.handle('/tapcanvas', async (endpoint, payload) => {
    if (endpoint !== 'scope') {
      return failure('tapcanvas/not-found', '未知 TapCanvas 原生 RPC 方法', { endpoint })
    }
    const parsed = parseScope(payload)
    if (parsed === null) {
      return failure('tapcanvas/invalid-scope', 'TapCanvas 作用域消息缺少有效的 sessionId 或画布标识')
    }
    scopes.set(parsed.sessionId, parsed.scope)
    return success({ accepted: true })
  })

  ctx.systemPrompt.context({
    name: 'runtime:tapcanvas-scope',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
    text: (assembly) => {
      const scope = scopeForAgent(assembly.scope)
      if (scope === null) return ''
      return JSON.stringify({
        source: 'TapCanvas 当前真实画布作用域',
        projectId: scope.projectId,
        projectName: scope.projectName,
        flowId: scope.flowId,
        chapterId: scope.chapterId,
        chapterTitle: scope.chapterTitle,
        bookId: scope.bookId,
        selectedNodeIds: scope.selectedNodeIds,
        canvas: scope.canvas,
      })
    },
  })

  ctx.systemPrompt.section({
    name: 'tool:tapcanvas-native',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WEB_FETCH'),
    text: '当前会话包含 TapCanvas 画布作用域。需要读取画布事实时调用 tapcanvas_get_current_canvas；若作用域缺失，必须明确报告无法读取，不得猜测项目或流程。',
  })

  ctx.tools.register(defineTool({
    name: 'tapcanvas_get_current_canvas',
    description: '读取浏览器当前 TapCanvas 画布的项目、流程、节点和边快照。没有当前作用域时返回明确错误。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (_args, exec) => {
      const scope = scopeForAgent(exec.agent)
      if (scope === null) throw new Error('TapCanvas 当前作用域不可用：请先在画布页面打开原生 Agent')
      return JSON.stringify(scope)
    },
  }))
}

export function clearTapCanvasScope(sessionId: string): void {
  scopes.delete(sessionId)
}
