import { describe, expect, it } from 'vitest'

import {
  buildWaveMotions,
  canAnimateCharacterWithHyperframes,
  readCharacterDecomposition,
} from './characterHyperframesContract'

function createDecomposition(): Record<string, unknown> {
  return {
    characterDecomposition: {
      frameSize: [1280, 1280],
      parts: [
        {
          tag: 'handwear-r',
          assetName: 'see-through:handwear-r',
          xyxy: [620, 480, 880, 920],
          depthMedian: 0.8,
          url: 'https://assets.example/handwear-r.png',
        },
        {
          tag: 'front hair',
          assetName: 'see-through:front hair',
          xyxy: [410, 140, 770, 580],
          depthMedian: 0.2,
          url: 'https://assets.example/front-hair.png',
        },
      ],
    },
  }
}

describe('HyperFrames 角色动画动作数据', () => {
  it('读取已托管的 See-through 部件并创建挥手与发丝动作', () => {
    const decomposition = readCharacterDecomposition(createDecomposition())
    expect(decomposition).not.toBeNull()
    if (!decomposition) throw new Error('角色组件读取失败')

    const motions = buildWaveMotions(decomposition.parts)
    expect(motions.map((motion) => motion.tag)).toEqual(['handwear-r', 'front hair'])
    expect(motions[0]?.keyframes).toHaveLength(5)
    expect(motions[0]?.keyframes.at(-1)).toMatchObject({ second: 4, rotationDeg: 0 })
  })

  it('只在存在完整、HTTP 托管部件时显示组件动画入口', () => {
    expect(canAnimateCharacterWithHyperframes(createDecomposition())).toBe(true)
    expect(canAnimateCharacterWithHyperframes({
      characterDecomposition: {
        frameSize: [1280, 1280],
        parts: [{
          tag: 'front hair',
          assetName: 'see-through:front hair',
          xyxy: [0, 0, 100, 100],
          depthMedian: 0.1,
          url: 'file:///private/front-hair.png',
        }],
      },
    })).toBe(false)
  })
})
