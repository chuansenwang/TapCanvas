import React from 'react'
import { ActionIcon } from '@mantine/core'
import { IconX } from '@tabler/icons-react'
import { useUIStore } from './uiStore'
import { isCanvasNodeDragActive, useRFStore } from '../canvas/store'
import { listNewApiModels } from '../api/server'
import './NativeAgentWorkspaceModal.css'

type TapCanvasScopeMessage = {
  type: 'tapcanvas:scope'
  scope: {
    projectId: string | null
    projectName: string | null
    flowId: string | null
    chapterId: string | null
    chapterTitle: string | null
    bookId: string | null
    selectedNodeIds: string[]
    canvas: {
      nodes: Array<{ id: string; type: string | null; position: { x: number; y: number }; data: Record<string, unknown> }>
      edges: Array<{ id: string; source: string; target: string; sourceHandle: string | null; targetHandle: string | null }>
    } | null
  }
}

type TapCanvasModelCatalogMessage = {
  type: 'tapcanvas:model-catalog'
  catalog: {
    groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }>
    failures: Array<{ id: string; name: string; message: string }>
  }
}

let selectedNodeIdsSource: ReturnType<typeof useRFStore.getState>['nodes'] | null = null
let selectedNodeIdsCache: string[] = []

function selectSelectedNodeIds(state: ReturnType<typeof useRFStore.getState>): string[] {
  if (isCanvasNodeDragActive() && selectedNodeIdsSource !== null) return selectedNodeIdsCache
  if (state.nodes === selectedNodeIdsSource) return selectedNodeIdsCache
  selectedNodeIdsSource = state.nodes
  selectedNodeIdsCache = state.nodes.reduce<string[]>((ids, node) => {
    if (node.selected) ids.push(node.id)
    return ids
  }, [])
  return selectedNodeIdsCache
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/**
 * 在 TapCanvas 的当前页面内承载 Harness 原生工作区。
 * `/agent/` 与画布使用同一个浏览器 Origin，由 Harness Web Server 提供。
 * Harness 的文件系统 Workspace 不承载画布数据；画布作用域通过结构化消息传入。
 */
export function NativeAgentWorkspaceModal(): JSX.Element | null {
  const opened = useUIStore((state) => state.nativeAgentWorkspaceOpen)
  const close = useUIStore((state) => state.closeNativeAgentWorkspace)
  const project = useUIStore((state) => state.currentProject)
  const flow = useUIStore((state) => state.currentFlow)
  const chapter = useUIStore((state) => state.currentChapter)
  const selectedNodeIds = useRFStore(selectSelectedNodeIds, areStringArraysEqual)
  const canvasSource = useRFStore((state) => ({ nodes: state.nodes, edges: state.edges }), (left, right) =>
    left.nodes === right.nodes && left.edges === right.edges)
  const canvas = React.useMemo(() => ({
    nodes: canvasSource.nodes.map((node) => ({
      id: node.id,
      type: typeof node.type === 'string' ? node.type : null,
      position: { x: node.position.x, y: node.position.y },
      data: node.data as Record<string, unknown>,
    })),
    edges: canvasSource.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  }), [canvasSource])
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null)
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null)
  const agentSrc = React.useMemo(() => {
    const search = window.location.search
    return search === '' ? '/agent/' : `/agent/${search}`
  }, [])
  const [modelCatalogMessage, setModelCatalogMessage] = React.useState<TapCanvasModelCatalogMessage>({
    type: 'tapcanvas:model-catalog',
    catalog: { groups: [], failures: [] },
  })

  const scopeMessage = React.useMemo<TapCanvasScopeMessage>(() => ({
    type: 'tapcanvas:scope',
    scope: {
      projectId: project?.id ? String(project.id).trim() : null,
      projectName: project?.name ? String(project.name).trim() : null,
      flowId: flow?.id ? String(flow.id).trim() : null,
      chapterId: chapter?.chapterId ? String(chapter.chapterId).trim() : null,
      chapterTitle: chapter?.chapterTitle ? String(chapter.chapterTitle).trim() : null,
      bookId: chapter?.bookId ? String(chapter.bookId).trim() : null,
      selectedNodeIds: [...selectedNodeIds],
      canvas,
    },
  }), [canvas, chapter, flow, project, selectedNodeIds])

  const publishScope = React.useCallback(() => {
    const frame = iframeRef.current
    if (frame?.contentWindow === null || frame?.contentWindow === undefined) return
    frame.contentWindow.postMessage(scopeMessage, window.location.origin)
    frame.contentWindow.postMessage(modelCatalogMessage, window.location.origin)
  }, [modelCatalogMessage, scopeMessage])

  React.useEffect(() => {
    if (!opened) return
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== window.location.origin) return
      if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return
      const message = event.data as { type?: unknown }
      if (message.type === 'tapcanvas:scope-request') publishScope()
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [opened, publishScope])

  React.useEffect(() => {
    if (!opened) return
    let cancelled = false
    void listNewApiModels({ kind: 'text', enabled: true, selectable: true })
      .then((models) => {
        if (cancelled) return
        const seen = new Set<string>()
        const rows = models.flatMap((model) => {
          const id = typeof model.requestModelKey === 'string' ? model.requestModelKey.trim() : ''
          if (!id || seen.has(id)) return []
          seen.add(id)
          const name = typeof model.displayLabel === 'string' && model.displayLabel.trim()
            ? model.displayLabel.trim()
            : model.modelName.trim()
          return [{
            id,
            name,
            ...(typeof model.description === 'string' && model.description.trim()
              ? { description: model.description.trim() } : {}),
          }]
        })
        setModelCatalogMessage({
          type: 'tapcanvas:model-catalog',
          catalog: {
            groups: rows.length > 0 ? [{ id: 'new-api', name: 'New API', models: rows }] : [],
            failures: [],
          },
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setModelCatalogMessage({
          type: 'tapcanvas:model-catalog',
          catalog: {
            groups: [],
            failures: [{
              id: 'new-api',
              name: 'New API',
              message: error instanceof Error ? error.message : String(error),
            }],
          },
        })
      })
    return () => { cancelled = true }
  }, [opened])

  React.useEffect(() => {
    if (!opened) return
    publishScope()
    closeButtonRef.current?.focus()
  }, [opened, publishScope])

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') close()
  }, [close])

  if (!opened) return null

  return (
    <div className="native-agent-workspace-modal" role="dialog" aria-modal="true" aria-label="导演小T" onKeyDown={handleKeyDown}>
      <div className="native-agent-workspace-modal__backdrop" onClick={close} aria-hidden="true" />
      <aside className="native-agent-workspace-modal__panel">
        <header className="native-agent-workspace-modal__header">
          <h2 className="native-agent-workspace-modal__title">导演小T</h2>
          <ActionIcon
            className="native-agent-workspace-modal__close"
            ref={closeButtonRef}
            variant="subtle"
            color="gray"
            aria-label="收起导演小T"
            onClick={close}
          >
            <IconX size={18} />
          </ActionIcon>
        </header>
        <div className="native-agent-workspace-modal__body">
        <iframe
          ref={iframeRef}
          className="native-agent-workspace-modal__frame"
          src={agentSrc}
          title="导演小T原生工作区"
          onLoad={publishScope}
        />
        </div>
      </aside>
    </div>
  )
}
