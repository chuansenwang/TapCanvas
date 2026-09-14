import {
  createCharacterAnimationSpec,
  createCharacterAnimationState,
} from '@tapcanvas/character-animation-protocol'
import { runTaskByVendor, type TaskResultDto } from '../../../api/server'
import { notifyAssetRefresh } from '../../../ui/assetEvents'
import { toast } from '../../../ui/toast'
import { withCanvasGenerationContext } from '../../../runner/generationAssetContext'
import { useRFStore } from '../../store'
import { useUIStore } from '../../../ui/uiStore'
import { buildWaveMotions, readCharacterDecomposition } from './characterHyperframesContract'

type Input = Readonly<{
  data: Record<string, unknown>
  nodeId: string
  nodeWidth: number
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readVideoResult(result: TaskResultDto): { url: string; durationSec: number | null } | null {
  const asset = result.assets.find((item) => item.type === 'video' && typeof item.url === 'string' && item.url.trim())
  if (!asset) return null
  const raw = isRecord(result.raw) && isRecord(result.raw.characterAnimation) ? result.raw.characterAnimation : null
  const durationSec = raw ? readNumber(raw.durationSec) : null
  return { url: asset.url.trim(), durationSec }
}

export async function runCharacterHyperframesAnimation(input: Input): Promise<void> {
  const decomposition = readCharacterDecomposition(input.data)
  if (!decomposition) throw new Error('当前节点没有完整、已托管的 See-through 角色组件，不能生成 HyperFrames 动画')
  const durationSec = 4
  const motions = buildWaveMotions(decomposition.parts)
  if (motions.length === 0) throw new Error('当前角色组件没有可执行的手部或发丝动作部件')
  const store = useRFStore.getState()
  const knownIds = new Set(store.nodes.map((node) => node.id))
  store.addNode('taskNode', 'HyperFrames 角色动画', {
    kind: 'video',
    status: 'running',
    characterAnimationState: {
      ...createCharacterAnimationState('running'),
      attempt: 1,
      progress: 5,
      startedAt: new Date().toISOString(),
    },
  })
  const operationNode = useRFStore.getState().nodes.find((node) => !knownIds.has(node.id))
  if (!operationNode) throw new Error('HyperFrames 角色动画节点创建失败')
  const sourceNode = useRFStore.getState().nodes.find((node) => node.id === input.nodeId)
  useRFStore.getState().onNodesChange([{
    id: operationNode.id,
    type: 'position',
    position: { x: (sourceNode?.position.x ?? 0) + input.nodeWidth + 80, y: sourceNode?.position.y ?? 0 },
    dragging: false,
  }])
  useRFStore.getState().onConnect({ source: input.nodeId, sourceHandle: 'out-image', target: operationNode.id, targetHandle: 'in-any' })
  try {
    const animation = createCharacterAnimationSpec({
      compositionId: `see-through-${operationNode.id}`,
      sourceNodeId: input.nodeId,
      frameSize: decomposition.frameSize,
      durationSec,
      backgroundColor: '#ffffff',
      parts: decomposition.parts,
      motions,
    })
    const result = await runTaskByVendor('auto', withCanvasGenerationContext({
      kind: 'image_edit',
      prompt: '使用 HyperFrames 依据 See-through 透明角色部件渲染一个二维角色小幅挥手动画。',
      extras: { imageOperation: 'character_animate_hyperframes', characterAnimation: animation, fps: 24 },
    }, useUIStore.getState(), operationNode.id))
    const video = readVideoResult(result)
    if (!video) throw new Error('HyperFrames 未返回真实视频资产')
    useRFStore.getState().updateNodeData(operationNode.id, {
      videoUrl: video.url,
      videoResults: [{ url: video.url, title: '角色轻挥手动画' }],
      videoPrimaryIndex: 0,
      status: 'done',
      label: 'HyperFrames 角色动画 · 轻挥手',
      characterAnimation: animation,
      characterAnimationState: {
        ...createCharacterAnimationState('succeeded'),
        attempt: 1,
        startedAt: animation.createdAt,
        finishedAt: new Date().toISOString(),
        videoUrl: video.url,
      },
    })
    notifyAssetRefresh()
    toast('HyperFrames 角色动画已生成', 'success')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'HyperFrames 角色动画失败'
    useRFStore.getState().updateNodeData(operationNode.id, {
      status: 'error',
      error: message,
      characterAnimationState: {
        ...createCharacterAnimationState('failed'),
        attempt: 1,
        finishedAt: new Date().toISOString(),
        error: { code: 'hyperframes_character_animation_failed', message, retryable: true },
      },
    })
    toast(message, 'error')
  }
}
