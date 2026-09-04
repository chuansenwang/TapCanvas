import { useEffect, useState } from 'react'

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

export interface TapCanvasScopeMessage {
  readonly type: 'tapcanvas:scope'
  readonly scope: TapCanvasScope
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
    .map((item) => item.trim())
    .filter((item) => item !== '')
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

/** Receive the parent TapCanvas scope without coupling Harness to TapCanvas stores. */
export function useTapCanvasScope(): TapCanvasScope | null {
  const [scope, setScope] = useState<TapCanvasScope | null>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window.parent) return
      if (event.origin !== window.location.origin) return
      const message = parseTapCanvasScopeMessage(event.data)
      if (message !== null) setScope(message.scope)
    }
    window.addEventListener('message', onMessage)
    // The parent can finish mounting before this listener exists. Request the
    // authoritative scope after registration so the embedded Agent never
    // falls back to the Harness directory picker because of load ordering.
    window.parent.postMessage({ type: TAPCANVAS_SCOPE_REQUEST }, window.location.origin)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  return scope
}
