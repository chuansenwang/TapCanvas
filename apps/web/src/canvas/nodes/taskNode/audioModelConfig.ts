import type { ModelOption } from '../../../config/models'
import { readCatalogTags } from './mediaModelControls'

export type AudioModelCapability = 'speech' | 'music'

export type AudioModelParameterType = 'boolean' | 'enum' | 'float' | 'integer' | 'number' | 'string'

export type AudioModelParameterOption = {
  value: string
  label: string
}

export type AudioModelParameter = {
  key: string
  label: string
  type: AudioModelParameterType
  defaultValue: string | number | boolean | null
  required: boolean
  min?: number
  max?: number
  step?: number
  options: ReadonlyArray<AudioModelParameterOption>
}

type UnknownRecord = Record<string, unknown>

const AUDIO_PARAMETER_TYPES = new Set<AudioModelParameterType>([
  'boolean',
  'enum',
  'float',
  'integer',
  'number',
  'string',
])

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readAudioParameterOptions(value: unknown): AudioModelParameterOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    const record = asRecord(candidate)
    if (!record) return []
    const rawValue = record.value
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') return []
    const valueText = String(rawValue).trim()
    if (!valueText) return []
    return [{ value: valueText, label: asTrimmedString(record.label) || valueText }]
  })
}

function readAudioParameter(value: unknown): AudioModelParameter | null {
  const record = asRecord(value)
  if (!record) return null
  const key = asTrimmedString(record.key)
  const type = asTrimmedString(record.type) as AudioModelParameterType
  if (!key || !AUDIO_PARAMETER_TYPES.has(type)) return null
  const defaultValue = record.default
  const validDefault = typeof defaultValue === 'string' || typeof defaultValue === 'number' || typeof defaultValue === 'boolean'
    ? defaultValue
    : null
  return {
    key,
    label: asTrimmedString(record.label) || key,
    type,
    defaultValue: validDefault,
    required: record.required === true,
    ...(typeof record.min === 'number' && Number.isFinite(record.min) ? { min: record.min } : {}),
    ...(typeof record.max === 'number' && Number.isFinite(record.max) ? { max: record.max } : {}),
    ...(typeof record.step === 'number' && Number.isFinite(record.step) && record.step > 0 ? { step: record.step } : {}),
    options: readAudioParameterOptions(record.options),
  }
}

/** Returns the executable generation capability declared by the live model catalog. */
export function readAudioModelCapability(option: ModelOption | null | undefined): AudioModelCapability | null {
  if (!option) return null
  const tags = readCatalogTags(option)
  if (tags.includes('tapcanvas:audio-type=speech')) return 'speech'
  if (tags.includes('tapcanvas:audio-type=music')) return 'music'
  return null
}

export function formatAudioModelCapability(capability: AudioModelCapability | null): string {
  if (capability === 'music') return '音乐'
  if (capability === 'speech') return '语音'
  return '未声明类型'
}

/**
 * Runtime parameters are supplied by the same dynamic model catalog as the
 * selected model. No client-side model or vendor list participates here.
 */
export function readAudioModelParameters(option: ModelOption | null | undefined): AudioModelParameter[] {
  const meta = asRecord(option?.meta)
  const runtimeParameters = meta?.runtimeParameters
  if (!Array.isArray(runtimeParameters)) return []
  return runtimeParameters.flatMap((parameter) => {
    const parsed = readAudioParameter(parameter)
    return parsed ? [parsed] : []
  })
}
