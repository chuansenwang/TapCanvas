export const CHARACTER_ANIMATION_SCHEMA_VERSION = 1 as const

export type CharacterAnimationEngine = 'hyperframes'

export type CharacterAnimationKeyframe = Readonly<{
  second: number
  x: number
  y: number
  rotationDeg: number
  scaleX?: number
  scaleY?: number
  opacity?: number
}>

export type CharacterAnimationMotion = Readonly<{
  tag: string
  origin: readonly [number, number]
  keyframes: readonly CharacterAnimationKeyframe[]
}>

export type CharacterAnimationPart = Readonly<{
  tag: string
  assetName: string
  xyxy: readonly [number, number, number, number]
  depthMedian: number
  url: string
}>

export type CharacterAnimationSpec = Readonly<{
  schemaVersion: typeof CHARACTER_ANIMATION_SCHEMA_VERSION
  engine: CharacterAnimationEngine
  compositionId: string
  sourceNodeId: string
  frameSize: readonly [number, number]
  durationSec: number
  backgroundColor: string
  parts: readonly CharacterAnimationPart[]
  motions: readonly CharacterAnimationMotion[]
  createdAt: string
}>

export type CharacterAnimationPhase = 'queued' | 'running' | 'succeeded' | 'failed'

export type CharacterAnimationState = Readonly<{
  schemaVersion: typeof CHARACTER_ANIMATION_SCHEMA_VERSION
  phase: CharacterAnimationPhase
  progress: number
  attempt: number
  queuedAt?: string
  startedAt?: string
  finishedAt?: string
  error?: Readonly<{ code: string; message: string; retryable: boolean }>
  videoUrl?: string
}>

export type CreateCharacterAnimationInput = Readonly<{
  compositionId: string
  sourceNodeId: string
  frameSize: readonly [number, number]
  durationSec: number
  backgroundColor: string
  parts: readonly CharacterAnimationPart[]
  motions: readonly CharacterAnimationMotion[]
  createdAt?: string
}>

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`角色动画合同缺少 ${field}`)
  return value.trim()
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`角色动画合同 ${field} 无效`)
  return value
}

function readTuple(value: unknown, length: number, field: string): readonly number[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`角色动画合同 ${field} 无效`)
  return value.map((item, index) => readNumber(item, `${field}[${index}]`))
}

function readHttpUrl(value: unknown, field: string): string {
  const url = readString(value, field)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`角色动画合同 ${field} 必须是 http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`角色动画合同 ${field} 必须是 http(s) URL`)
  }
  return url
}

function readBackgroundColor(value: unknown): string {
  const color = readString(value, 'backgroundColor')
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) {
    throw new Error('角色动画合同 backgroundColor 必须是十六进制颜色')
  }
  return color
}

function parseParts(value: unknown): readonly CharacterAnimationPart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    throw new Error('角色动画合同 parts 必须包含 1 到 24 个部件')
  }
  const parts = value.map((item): CharacterAnimationPart => {
    if (!isRecord(item)) throw new Error('角色动画合同部件必须是对象')
    const xyxy = readTuple(item.xyxy, 4, 'part.xyxy')
    if (xyxy[2] <= xyxy[0] || xyxy[3] <= xyxy[1]) throw new Error('角色动画合同 part.xyxy 无效')
    return {
      tag: readString(item.tag, 'part.tag'),
      assetName: readString(item.assetName, 'part.assetName'),
      xyxy: [xyxy[0], xyxy[1], xyxy[2], xyxy[3]],
      depthMedian: readNumber(item.depthMedian, 'part.depthMedian'),
      url: readHttpUrl(item.url, 'part.url'),
    }
  })
  if (new Set(parts.map((part) => part.tag)).size !== parts.length) {
    throw new Error('角色动画合同部件标签必须唯一')
  }
  return parts
}

function parseMotions(value: unknown, partTags: ReadonlySet<string>, durationSec: number): readonly CharacterAnimationMotion[] {
  if (!Array.isArray(value)) throw new Error('角色动画合同 motions 必须是数组')
  return value.map((item): CharacterAnimationMotion => {
    if (!isRecord(item)) throw new Error('角色动画合同动作必须是对象')
    const tag = readString(item.tag, 'motion.tag')
    if (!partTags.has(tag)) throw new Error(`角色动画合同动作引用了不存在的部件：${tag}`)
    const origin = readTuple(item.origin, 2, 'motion.origin')
    if (origin[0] < 0 || origin[0] > 1 || origin[1] < 0 || origin[1] > 1) {
      throw new Error('角色动画合同 motion.origin 必须在 0 到 1 之间')
    }
    if (!Array.isArray(item.keyframes) || item.keyframes.length < 2) {
      throw new Error('角色动画合同动作至少需要两个关键帧')
    }
    let previousSecond = -1
    const keyframes = item.keyframes.map((frame): CharacterAnimationKeyframe => {
      if (!isRecord(frame)) throw new Error('角色动画合同关键帧必须是对象')
      const second = readNumber(frame.second, 'keyframe.second')
      if (second < 0 || second > durationSec || second <= previousSecond) {
        throw new Error('角色动画合同关键帧时间必须严格递增且位于时长内')
      }
      previousSecond = second
      return {
        second,
        x: readNumber(frame.x, 'keyframe.x'),
        y: readNumber(frame.y, 'keyframe.y'),
        rotationDeg: readNumber(frame.rotationDeg, 'keyframe.rotationDeg'),
        ...(typeof frame.scaleX === 'number' ? { scaleX: readNumber(frame.scaleX, 'keyframe.scaleX') } : {}),
        ...(typeof frame.scaleY === 'number' ? { scaleY: readNumber(frame.scaleY, 'keyframe.scaleY') } : {}),
        ...(typeof frame.opacity === 'number' ? { opacity: readNumber(frame.opacity, 'keyframe.opacity') } : {}),
      }
    })
    return { tag, origin: [origin[0], origin[1]], keyframes }
  })
}

export function parseCharacterAnimationSpec(value: unknown): CharacterAnimationSpec {
  if (!isRecord(value)) throw new Error('角色动画合同必须是对象')
  if (value.schemaVersion !== CHARACTER_ANIMATION_SCHEMA_VERSION) {
    throw new Error(`不支持的角色动画合同版本：${String(value.schemaVersion)}`)
  }
  if (value.engine !== 'hyperframes') throw new Error('角色动画合同 engine 无效')
  const frameSize = readTuple(value.frameSize, 2, 'frameSize')
  if (frameSize[0] < 1 || frameSize[1] < 1) throw new Error('角色动画合同 frameSize 必须为正数')
  const durationSec = readNumber(value.durationSec, 'durationSec')
  if (durationSec <= 0 || durationSec > 30) throw new Error('角色动画合同时长必须在 0 到 30 秒之间')
  const parts = parseParts(value.parts)
  return {
    schemaVersion: CHARACTER_ANIMATION_SCHEMA_VERSION,
    engine: 'hyperframes',
    compositionId: readString(value.compositionId, 'compositionId'),
    sourceNodeId: readString(value.sourceNodeId, 'sourceNodeId'),
    frameSize: [frameSize[0], frameSize[1]],
    durationSec,
    backgroundColor: readBackgroundColor(value.backgroundColor),
    parts,
    motions: parseMotions(value.motions, new Set(parts.map((part) => part.tag)), durationSec),
    createdAt: readString(value.createdAt, 'createdAt'),
  }
}

export function createCharacterAnimationSpec(input: CreateCharacterAnimationInput): CharacterAnimationSpec {
  return parseCharacterAnimationSpec({
    schemaVersion: CHARACTER_ANIMATION_SCHEMA_VERSION,
    engine: 'hyperframes',
    compositionId: input.compositionId,
    sourceNodeId: input.sourceNodeId,
    frameSize: input.frameSize,
    durationSec: input.durationSec,
    backgroundColor: input.backgroundColor,
    parts: input.parts,
    motions: input.motions,
    createdAt: input.createdAt ?? new Date().toISOString(),
  })
}

export function createCharacterAnimationState(phase: CharacterAnimationPhase): CharacterAnimationState {
  return {
    schemaVersion: CHARACTER_ANIMATION_SCHEMA_VERSION,
    phase,
    progress: phase === 'succeeded' ? 100 : 0,
    attempt: 0,
  }
}
