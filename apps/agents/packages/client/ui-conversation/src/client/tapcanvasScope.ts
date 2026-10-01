import { useEffect, useSyncExternalStore } from 'react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface TapCanvasScope {
  readonly userId?: string | null
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

export interface TapCanvasScopeMessage {
  readonly type: 'tapcanvas:scope'
  readonly scope: TapCanvasScope
}

/**
 * 一个画布作用域的运行时视图：作用域本身，加上它的归属 origin。
 *
 * 归属 origin 是解析相对资产 URL 的唯一依据。Agent 页面与画布页面不同源，
 * 没有它就无法把画布上的 `/assets/...` 读成真实字节。
 */
export interface TapCanvasScopeView {
  readonly scope: TapCanvasScope
  /** 承载 iframe 的画布页面 origin；来源元数据不可信时为 null。 */
  readonly origin: string | null
}

/**
 * 唯一的画布作用域来源。
 *
 * 安装父页面消息监听并把每条已校验消息发布到 {@link TapCanvasScopeHub.store}。
 * 会话界面与其它客户端插件读同一个 store，因此不存在第二份未校验的画布事实。
 */
export class TapCanvasScopeHub {
  /** 已校验的当前画布作用域（未同步时为 null）。 */
  readonly store: SnapshotStore<TapCanvasScopeView | null> = createSnapshotStore<TapCanvasScopeView | null>(null)

  /** 当前持有监听的消费方数量；归零即卸载监听并清空作用域。 */
  private consumers = 0
  /** 已安装监听的卸载函数；null 表示尚未安装。 */
  private stop: (() => void) | null = null

  /**
   * 为一个消费方持有监听（引用计数）。
   *
   * 第一处调用安装监听，最后一次释放卸载它；中间的重挂载既不会重复安装，也不会
   * 让上一个挂载周期的作用域残留给下一个消费方。非嵌入环境（`window.parent ===
   * window`）不安装：顶层 Agent 页面没有画布父页面，伪造作用域比缺失更糟。
   * @returns 该消费方的释放函数（幂等）。
   */
  start(): () => void {
    this.consumers += 1
    this.stop ??= this.install()
    let released = false
    return () => {
      if (released) return
      released = true
      this.consumers -= 1
      if (this.consumers > 0) return
      this.consumers = 0
      this.stop?.()
      this.stop = null
      // 没有消费方就没有画布事实：留着上一轮的作用域会让下一次挂载在收到父页面
      // 消息之前，先以一个过期画布对外表现成已绑定。
      this.store.set(null)
    }
  }

  /**
   * 安装父页面监听。
   *
   * 无论是否嵌入都安装：非嵌入时 `resolveTapCanvasParentOrigin` 以自身 origin
   * 为准，随后到达的同源作用域消息仍然有效（顶层 Agent 页面同样可以持有作用域）。
   */
  private install(): () => void {
    if (typeof window === 'undefined') return () => {}
    const explicitParentOrigin = new URLSearchParams(window.location.search).get('parentOrigin') ?? ''
    const parentOrigin = resolveTapCanvasParentOrigin(
      document.referrer,
      window.location.origin,
      window.parent !== window,
      window.location.ancestorOrigins?.[0],
      explicitParentOrigin,
    )
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window.parent) return
      // 没有可信父 origin 的嵌入页面不得接受任意跨域消息；作用域保持不可用。
      if (parentOrigin === null || event.origin !== parentOrigin) return
      const message = parseTapCanvasScopeMessage(event.data)
      if (message === null) return
      this.store.set({ scope: message.scope, origin: parentOrigin })
    }
    window.addEventListener('message', onMessage)
    // 父页面可能在本监听安装前就完成了挂载，因此注册后主动请求一次权威作用域。
    window.parent.postMessage({ type: TAPCANVAS_SCOPE_REQUEST }, parentOrigin ?? '*')
    return () => { window.removeEventListener('message', onMessage) }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * 已校验的 TapCanvas 画布作用域（含画布页面 origin）。
     *
     * 会话界面写入它，其它客户端插件读取它。写入者只有父页面消息的
     * 校验方；消费者不做二次信任判断。
     */
    tapCanvasScope: TapCanvasScopeHub
  }
}

export interface TapCanvasExternalModel {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface TapCanvasExternalModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly TapCanvasExternalModel[]
}

export interface TapCanvasModelCatalogMessage {
  readonly type: 'tapcanvas:model-catalog'
  readonly catalog: {
    readonly groups: readonly TapCanvasExternalModelGroup[]
    readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
  }
}

const TAPCANVAS_SCOPE_REQUEST = 'tapcanvas:scope-request'

/**
 * Resolve the origin of the page embedding the Agent surface.
 *
 * The native Agent is hosted on 3080 while the development TapCanvas shell is
 * hosted on 5175. `window.location.origin` therefore identifies the Agent,
 * not the parent that owns the canvas scope. A referrer is the browser-provided
 * parent URL and remains available without reading any cross-origin DOM.
 */
export function resolveTapCanvasParentOrigin(
  referrer: string,
  ownOrigin: string,
  embedded: boolean,
  ancestorOrigin?: string,
  explicitParentOrigin?: string,
): string | null {
  if (!embedded) return ownOrigin
  const candidates = [explicitParentOrigin?.trim() ?? '', referrer.trim(), ancestorOrigin?.trim() ?? '']
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      const origin = new URL(candidate).origin
      if (origin !== 'null') return origin
    } catch {
      // Try the browser-provided ancestor origin when referrer is malformed.
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item !== '')
}

function parseCanvas(value: unknown): TapCanvasCanvasSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null
  const nodes = value.nodes.flatMap((item): TapCanvasNodeSnapshot[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.position)) return []
    const x = typeof item.position.x === 'number' ? item.position.x : NaN
    const y = typeof item.position.y === 'number' ? item.position.y : NaN
    if (!Number.isFinite(x) || !Number.isFinite(y)) return []
    return [{
      id: item.id.trim(),
      type: nullableString(item.type),
      position: { x, y },
      data: isRecord(item.data) ? item.data : {},
    }]
  })
  const edges = value.edges.flatMap((item): TapCanvasEdgeSnapshot[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.source !== 'string' || typeof item.target !== 'string') return []
    return [{
      id: item.id.trim(),
      source: item.source.trim(),
      target: item.target.trim(),
      sourceHandle: nullableString(item.sourceHandle),
      targetHandle: nullableString(item.targetHandle),
    }]
  })
  return { nodes, edges }
}

export function parseTapCanvasScope(value: unknown): TapCanvasScope | null {
  if (!isRecord(value)) return null
  const scope = isRecord(value.scope) ? value.scope : value
  return {
    userId: nullableString(scope.userId),
    projectId: nullableString(scope.projectId),
    projectName: nullableString(scope.projectName),
    flowId: nullableString(scope.flowId),
    chapterId: nullableString(scope.chapterId),
    chapterTitle: nullableString(scope.chapterTitle),
    bookId: nullableString(scope.bookId),
    selectedNodeIds: stringList(scope.selectedNodeIds),
    canvas: parseCanvas(scope.canvas),
  }
}

export function parseTapCanvasScopeMessage(value: unknown): TapCanvasScopeMessage | null {
  if (!isRecord(value) || value.type !== 'tapcanvas:scope') return null
  const scope = parseTapCanvasScope(value.scope)
  if (scope === null || (scope.projectId === null && scope.flowId === null && scope.canvas === null)) return null
  return { type: 'tapcanvas:scope', scope }
}

export function parseTapCanvasModelCatalogMessage(value: unknown): TapCanvasModelCatalogMessage | null {
  if (!isRecord(value) || value.type !== 'tapcanvas:model-catalog' || !isRecord(value.catalog)) return null
  const groupsValue = Array.isArray(value.catalog.groups) ? value.catalog.groups : []
  const groups: TapCanvasExternalModelGroup[] = []
  for (const groupValue of groupsValue) {
    if (!isRecord(groupValue) || typeof groupValue.id !== 'string' || typeof groupValue.name !== 'string') continue
    const modelsValue = Array.isArray(groupValue.models) ? groupValue.models : []
    const models: TapCanvasExternalModel[] = []
    for (const modelValue of modelsValue) {
      if (!isRecord(modelValue) || typeof modelValue.id !== 'string' || typeof modelValue.name !== 'string') continue
      models.push({
        id: modelValue.id.trim(),
        name: modelValue.name.trim(),
        ...(typeof modelValue.description === 'string' && modelValue.description.trim()
          ? { description: modelValue.description.trim() } : {}),
      })
    }
    if (groupValue.id.trim() && groupValue.name.trim() && models.length > 0) {
      groups.push({ id: groupValue.id.trim(), name: groupValue.name.trim(), models })
    }
  }
  const failuresValue = Array.isArray(value.catalog.failures) ? value.catalog.failures : []
  const failures = failuresValue.flatMap((failureValue): { id: string; name: string; message: string }[] => {
    if (!isRecord(failureValue)
      || typeof failureValue.id !== 'string'
      || typeof failureValue.name !== 'string'
      || typeof failureValue.message !== 'string') return []
    const id = failureValue.id.trim()
    const name = failureValue.name.trim()
    const message = failureValue.message.trim()
    return id && name && message ? [{ id, name, message }] : []
  })
  return { type: 'tapcanvas:model-catalog', catalog: { groups, failures } }
}

/**
 * 进程内唯一的画布作用域 hub。
 *
 * 客户端插件的 `apply` 每个进程只执行一次，React 组件却会反复挂载；把监听
 * 与快照放在模块级单例里，可以保证「一条已校验的父页面事实 + 一个订阅点」，
 * 而不是每个消费者各装一份监听。服务注册与单例指向同一实例。
 */
export const tapCanvasScopeHub = new TapCanvasScopeHub()

/**
 * 读取当前画布作用域的 React 钩子。
 *
 * 只做订阅与读取，不安装监听：监听由 {@link tapCanvasScopeHub} 的宿主生命周期
 * 负责。这样组件卸载重挂不会丢失作用域，也不会出现第二份未校验的画布事实。
 * @returns 已校验的画布作用域，未同步时为 null。
 */
export function useTapCanvasScope(): TapCanvasScope | null {
  useEffect(() => tapCanvasScopeHub.start(), [])
  const view = useSyncExternalStore(
    fn => tapCanvasScopeHub.store.subscribe(fn),
    () => tapCanvasScopeHub.store.getSnapshot(),
  )
  return view?.scope ?? null
}
