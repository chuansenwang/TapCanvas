import type { CharacterAnimationMotion, CharacterAnimationPart } from '@tapcanvas/character-animation-protocol'

export type CharacterDecomposition = Readonly<{
  frameSize: readonly [number, number]
  parts: readonly CharacterAnimationPart[]
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readTuple(value: unknown, length: number): readonly number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null
  const numbers = value.map(readNumber)
  return numbers.every((number): number is number => number !== null) ? numbers : null
}

export function readCharacterDecomposition(data: Record<string, unknown>): CharacterDecomposition | null {
  if (!isRecord(data.characterDecomposition)) return null
  const raw = data.characterDecomposition
  const frameSize = readTuple(raw.frameSize, 2)
  if (!frameSize || frameSize[0] < 1 || frameSize[1] < 1 || !Array.isArray(raw.parts)) return null
  const parts: CharacterAnimationPart[] = []
  for (const value of raw.parts) {
    if (!isRecord(value)) return null
    const tag = readString(value.tag)
    const assetName = readString(value.assetName)
    const url = readString(value.url)
    const xyxy = readTuple(value.xyxy, 4)
    const depthMedian = readNumber(value.depthMedian)
    if (!tag || !assetName || !url || !xyxy || depthMedian === null || xyxy[2] <= xyxy[0] || xyxy[3] <= xyxy[1]) return null
    if (!/^https?:\/\//i.test(url)) return null
    parts.push({ tag, assetName, url, xyxy: [xyxy[0], xyxy[1], xyxy[2], xyxy[3]], depthMedian })
  }
  return parts.length ? { frameSize: [frameSize[0], frameSize[1]], parts } : null
}

export function buildWaveMotions(parts: readonly CharacterAnimationPart[]): readonly CharacterAnimationMotion[] {
  const tagSet = new Set(parts.map((part) => part.tag))
  const motions: CharacterAnimationMotion[] = []
  const wavingHand = tagSet.has('handwear-r') ? 'handwear-r' : tagSet.has('handwear-l') ? 'handwear-l' : null
  if (wavingHand) {
    motions.push({
      tag: wavingHand,
      origin: [0.5, 0.12],
      keyframes: [
        { second: 0, x: 0, y: 0, rotationDeg: 0 },
        { second: 1.3, x: 4, y: -42, rotationDeg: -10 },
        { second: 2.1, x: 16, y: -47, rotationDeg: 8 },
        { second: 2.9, x: -4, y: -43, rotationDeg: -8 },
        { second: 4, x: 0, y: 0, rotationDeg: 0 },
      ],
    })
  }
  for (const tag of ['front hair', 'back hair']) {
    if (!tagSet.has(tag)) continue
    motions.push({
      tag,
      origin: [0.5, 0.12],
      keyframes: [
        { second: 0, x: 0, y: 0, rotationDeg: 0 },
        { second: 1.4, x: 4, y: 0, rotationDeg: 2 },
        { second: 2.7, x: -3, y: 1, rotationDeg: -2 },
        { second: 4, x: 0, y: 0, rotationDeg: 0 },
      ],
    })
  }
  return motions
}

export function canAnimateCharacterWithHyperframes(data: Record<string, unknown>): boolean {
  return readCharacterDecomposition(data) !== null
}
