import { createImageOperationState } from '@tapcanvas/image-operation-protocol'
import { fetchPublicTaskResultWithAuth, runTaskByVendor, type TaskResultDto } from '../../../api/server'
import { notifyAssetRefresh } from '../../../ui/assetEvents'
import { toast } from '../../../ui/toast'
import { withCanvasGenerationContext } from '../../../runner/generationAssetContext'
import { useRFStore } from '../../store'
import { useUIStore } from '../../../ui/uiStore'
import { createImageOperationForSource, readImageOperationSourceRevision } from './imageOperationFactory'

type CharacterPart = Readonly<{
  tag: string
  assetName: string
  xyxy: readonly [number, number, number, number]
  depthMedian: number
  partId: number | null
  url: string
  assetId: string | null
}>

type Decomposition = Readonly<{
  frameSize: readonly [number, number]
  parts: readonly CharacterPart[]
}>

type Input = Readonly<{
  data: Record<string, unknown>
  nodeId: string
  nodeWidth: number
  primaryImageUrl: string
  sleep: (milliseconds: number) => Promise<void>
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readXyxy(value: unknown): readonly [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const left = asNumber(value[0])
  const top = asNumber(value[1])
  const right = asNumber(value[2])
  const bottom = asNumber(value[3])
  if (left === null || top === null || right === null || bottom === null || right <= left || bottom <= top) return null
  return [Math.trunc(left), Math.trunc(top), Math.trunc(right), Math.trunc(bottom)]
}

function readDecomposition(result: TaskResultDto): Decomposition | null {
  if (!isRecord(result.raw) || !isRecord(result.raw.characterDecomposition)) return null
  const raw = result.raw.characterDecomposition
  if (!Array.isArray(raw.frameSize) || raw.frameSize.length !== 2 || !Array.isArray(raw.parts)) return null
  const width = asNumber(raw.frameSize[0])
  const height = asNumber(raw.frameSize[1])
  if (width === null || height === null || width < 1 || height < 1) return null
  const assets = new Map(result.assets.map((asset) => [asset.assetName ?? '', asset]))
  const parts: CharacterPart[] = []
  for (const value of raw.parts) {
    if (!isRecord(value)) return null
    const tag = asString(value.tag)
    const assetName = asString(value.assetName)
    const xyxy = readXyxy(value.xyxy)
    const depthMedian = asNumber(value.depthMedian)
    if (!tag || !assetName || !xyxy || depthMedian === null) return null
    const asset = assets.get(assetName)
    if (!asset?.url.trim()) return null
    parts.push({
      tag,
      assetName,
      xyxy,
      depthMedian,
      partId: typeof value.partId === 'number' && Number.isInteger(value.partId) ? value.partId : null,
      url: asset.url.trim(),
      assetId: asset.assetId ?? null,
    })
  }
  return parts.length ? { frameSize: [Math.trunc(width), Math.trunc(height)], parts } : null
}

export async function runCharacterDecomposition(input: Input): Promise<void> {
  const spec = createImageOperationForSource({
    kind: 'character_decompose',
    execution: 'local-character-decompose',
    sourceNodeId: input.nodeId,
    sourceUrl: input.primaryImageUrl,
    sourceRevision: readImageOperationSourceRevision(input.data.imageOperationRevision),
    parameters: { engine: 'see-through', splitLeftRight: true, output: 'semantic-rgba-parts' },
    output: { mediaType: 'image', count: 1, format: 'png', transparent: true },
  })
  const store = useRFStore.getState()
  const knownIds = new Set(store.nodes.map((node) => node.id))
  store.addNode('taskNode', '角色组件拆分', {
    kind: 'image',
    status: 'running',
    imageOperationSpec: spec,
    imageOperationState: { ...createImageOperationState(spec, 'running'), attempt: 1, progress: 5, startedAt: new Date().toISOString() },
    characterDecompositionEngine: 'see-through',
  })
  const operationNode = useRFStore.getState().nodes.find((node) => !knownIds.has(node.id))
  if (!operationNode) throw new Error('角色组件拆分任务节点创建失败')
  const sourceNode = useRFStore.getState().nodes.find((node) => node.id === input.nodeId)
  useRFStore.getState().onNodesChange([{
    id: operationNode.id,
    type: 'position',
    position: { x: (sourceNode?.position.x ?? 0) + input.nodeWidth + 80, y: sourceNode?.position.y ?? 0 },
    dragging: false,
  }])
  useRFStore.getState().onConnect({ source: input.nodeId, sourceHandle: 'out-image', target: operationNode.id, targetHandle: 'in-image' })
  try {
    const prompt = '使用 See-through 将这张二次元单角色图拆分为可动画的语义化透明 RGBA 组件。'
    let result = await runTaskByVendor('auto', withCanvasGenerationContext({
      kind: 'image_edit',
      prompt,
      extras: { imageOperation: 'character_decompose', imageOperationSpec: spec, referenceImages: [input.primaryImageUrl] },
    }, useUIStore.getState(), operationNode.id))
    let decomposition = readDecomposition(result)
    const deadline = Date.now() + 25 * 60 * 1000
    while (!decomposition && result.status !== 'failed' && Date.now() < deadline) {
      await input.sleep(2000)
      result = (await fetchPublicTaskResultWithAuth({ taskId: result.id, taskKind: 'image_edit', prompt })).result
      decomposition = readDecomposition(result)
    }
    if (!decomposition) throw new Error(result.status === 'failed' ? 'See-through 角色组件拆分执行失败' : 'See-through 未返回可用的角色组件与定位元数据')
    const imageResults = decomposition.parts.map((part) => ({ url: part.url, title: part.tag, assetId: part.assetId, assetName: part.assetName }))
    useRFStore.getState().updateNodeData(operationNode.id, {
      imageUrl: decomposition.parts[0]?.url,
      imageResults,
      imagePrimaryIndex: 0,
      status: 'done',
      label: '角色组件拆分 · ' + decomposition.parts.length + '件',
      characterDecomposition: decomposition,
      imageOperationState: {
        ...createImageOperationState(spec, 'succeeded'),
        attempt: 1,
        progress: 100,
        startedAt: spec.createdAt,
        finishedAt: new Date().toISOString(),
        resultAssets: decomposition.parts.map((part) => ({ role: 'layer' as const, url: part.url, assetId: part.assetId, mimeType: 'image/png' })),
      },
    })
    const partNodeIds: string[] = []
    for (const [index, part] of decomposition.parts.entries()) {
      const currentIds = new Set(useRFStore.getState().nodes.map((node) => node.id))
      useRFStore.getState().addNode('taskNode', part.tag, {
        kind: 'image', imageUrl: part.url, imageResults: [imageResults[index]], imagePrimaryIndex: 0,
        serverAssetId: part.assetId, status: 'done', isCharacterPart: true, characterPart: part,
        characterDecompositionNodeId: operationNode.id, characterSourceNodeId: input.nodeId, imageOperationSpec: spec,
      })
      const partNode = useRFStore.getState().nodes.find((node) => !currentIds.has(node.id))
      if (!partNode) throw new Error('角色部件节点创建失败：' + part.tag)
      partNodeIds.push(partNode.id)
      useRFStore.getState().onNodesChange([{
        id: partNode.id,
        type: 'position',
        position: { x: (sourceNode?.position.x ?? 0) + (input.nodeWidth + 80) * 2 + (index % 2) * (input.nodeWidth + 32), y: (sourceNode?.position.y ?? 0) + Math.floor(index / 2) * 260 },
        dragging: false,
      }])
    }
    const groupId = useRFStore.getState().createGroupForNodeIds(partNodeIds, 'See-through 角色组件 (' + partNodeIds.length + '件)', { preserveLayout: true })
    if (!groupId) throw new Error('角色组件图层组创建失败')
    useRFStore.getState().onConnect({ source: operationNode.id, sourceHandle: 'out-image', target: groupId, targetHandle: null })
    notifyAssetRefresh()
    toast('已拆分为 ' + decomposition.parts.length + ' 个可用于 HyperFrames 的语义角色组件', 'success')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '角色组件拆分失败'
    useRFStore.getState().updateNodeData(operationNode.id, {
      status: 'error', error: message,
      imageOperationState: { ...createImageOperationState(spec, 'failed'), attempt: 1, progress: 0, finishedAt: new Date().toISOString(), error: { code: 'character_decompose_failed', message, retryable: true } },
    })
    toast(message, 'error')
  }
}
