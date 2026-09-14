import { describe, expect, it } from 'vitest'
import type { ModelOption } from '../../../config/models'
import {
  formatAudioModelCapability,
  readAudioModelCapability,
  readAudioModelParameters,
} from './audioModelConfig'

function model(meta: unknown): ModelOption {
  return {
    value: 'audio-model-1',
    label: '测试音频模型',
    vendor: 'test-vendor',
    meta,
  }
}

describe('audioModelConfig', () => {
  it('从模型目录标签识别语音和音乐能力', () => {
    expect(readAudioModelCapability(model({ tags: ['tapcanvas:audio-type=speech'] }))).toBe('speech')
    expect(readAudioModelCapability(model({ tags: ['tapcanvas:audio-type=music'] }))).toBe('music')
    expect(formatAudioModelCapability('speech')).toBe('语音')
    expect(formatAudioModelCapability('music')).toBe('音乐')
  })

  it('未声明音频能力时返回 null', () => {
    expect(readAudioModelCapability(model({ tags: ['tapcanvas:audio-engine=minimax'] }))).toBeNull()
    expect(readAudioModelCapability(undefined)).toBeNull()
  })

  it('读取模型目录声明的 runtime 参数和默认值', () => {
    const parameters = readAudioModelParameters(model({
      tags: ['tapcanvas:audio-type=speech'],
      runtimeParameters: [
        {
          key: 'voice',
          label: '音色',
          type: 'enum',
          default: 'warm',
          required: true,
          options: [
            { value: 'warm', label: '温暖' },
            { value: 'clear', label: '清晰' },
          ],
        },
        {
          key: 'speed',
          label: '语速',
          type: 'float',
          default: 1,
          min: 0.5,
          max: 2,
          step: 0.1,
        },
        {
          key: 'stream',
          type: 'boolean',
          default: false,
        },
        {
          key: 'ignored',
          type: 'unsupported',
        },
      ],
    }))

    expect(parameters).toEqual([
      {
        key: 'voice',
        label: '音色',
        type: 'enum',
        defaultValue: 'warm',
        required: true,
        options: [
          { value: 'warm', label: '温暖' },
          { value: 'clear', label: '清晰' },
        ],
      },
      {
        key: 'speed',
        label: '语速',
        type: 'float',
        defaultValue: 1,
        required: false,
        min: 0.5,
        max: 2,
        step: 0.1,
        options: [],
      },
      {
        key: 'stream',
        label: 'stream',
        type: 'boolean',
        defaultValue: false,
        required: false,
        options: [],
      },
    ])
  })

  it('非对象或非数组 runtime 参数声明不会阻塞模型能力读取', () => {
    expect(readAudioModelParameters(model({
      tags: ['tapcanvas:audio-type=music'],
      runtimeParameters: 'invalid',
    }))).toEqual([])
    expect(readAudioModelParameters(model({
      tags: ['tapcanvas:audio-type=music'],
      runtimeParameters: [null, 1, { key: '', type: 'string' }],
    }))).toEqual([])
  })
})
