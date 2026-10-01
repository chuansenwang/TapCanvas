/**
 * TapCanvas 画布资产的纯投影：把父页面传入的画布快照整理成可引用的媒体候选，
 * 并把候选 URL 解析成 Agent 页面真正能取到字节的绝对地址。
 *
 * 本模块只做结构性读取（字段是否存在、类型是否为字符串、URL 是否可解析为
 * 绝对 http/https）。节点语义来自父页面写好的 `kind` 字段，这里不重新发明判定
 * 规则，也不为缺失字段补默认值。
 *
 * @module @deepseek-ai/dsh-client-ui-conversation/tapcanvas-canvas-assets
 */

import type { TapCanvasNodeSnapshot, TapCanvasScope } from './tapcanvasScope.ts'

/** 可引用画布资产的类型。模型能直接读到图片字节；视频只能提供首帧画面。 */
export type TapCanvasAssetKind = 'image' | 'video'

/** 画布上一个已有真实资产、可被引用的媒体节点。 */
export interface TapCanvasAssetCandidate {
  readonly nodeId: string
  readonly kind: TapCanvasAssetKind
  /** 节点标题；节点没有标题时用节点 ID，绝不伪造名称。 */
  readonly label: string
  /** 节点主资产 URL（图片为原图，视频为视频文件）。 */
  readonly url: string
  /** 视频节点的首帧/封面 URL；图片节点与无封面的视频均为 null。 */
  readonly posterUrl: string | null
}

/** 图片类节点 kind（与画布 taskNodeSchema 的 image 核心类型一致）。 */
const IMAGE_KINDS = new Set(['image', 'imageEdit'])

/** 视频类节点 kind（与画布 taskNodeSchema 的 video 核心类型一致）。 */
const VIDEO_KINDS = new Set(['video', 'videoCompose'])

/**
 * 读取一个非空字符串字段；空白字符串视为缺失。
 * @param value - 待读取的字段值。
 * @returns 去除首尾空白后的字符串，或 null。
 */
function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 读取一个数组字段；非数组视为空。
 *
 * `Array.isArray(unknown)` 会把元素宽化成 `any`，因此这里显式收窄为 `unknown[]`，
 * 让后续的逐项结构判断保持类型安全。
 * @param value - 待读取的字段值。
 * @returns 元素为 unknown 的数组。
 */
function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value as readonly unknown[] : []
}

/**
 * 取出节点主图 URL。
 *
 * `imageResults` + `imagePrimaryIndex` 的约定与画布一致：索引合法时读该条结果，
 * 否则回退到第一条真实结果。
 * @param data - 节点 data。
 * @returns URL 文本，或 null。
 */
function readImageUrl(data: Record<string, unknown>): string | null {
  const direct = readText(data.imageUrl)
  if (direct !== null) return direct
  const results = readArray(data.imageResults)
  const rawIndex = data.imagePrimaryIndex
  const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex)
    && rawIndex >= 0 && rawIndex < results.length
    ? rawIndex
    : 0
  const preferred = results[index]
  if (typeof preferred === 'object' && preferred !== null && !Array.isArray(preferred)) {
    const url = readText((preferred as Record<string, unknown>).url)
    if (url !== null) return url
  }
  for (const item of results) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const url = readText((item as Record<string, unknown>).url)
    if (url !== null) return url
  }
  return null
}

/**
 * 取出视频 URL 与其首帧封面 URL。
 * @param data - 节点 data。
 * @returns 视频 URL 与可选封面；没有真实视频 URL 时返回 null。
 */
function readVideoAsset(data: Record<string, unknown>): { url: string; posterUrl: string | null } | null {
  const results = readArray(data.videoResults)
  const rawIndex = data.videoPrimaryIndex
  const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex)
    && rawIndex >= 0 && rawIndex < results.length
    ? rawIndex
    : 0
  const result = results[index]
  const row = typeof result === 'object' && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null
  const url = readText(data.videoUrl) ?? (row === null ? null : readText(row.url))
  if (url === null) return null
  const posterUrl = readText(data.videoThumbnailUrl)
    ?? (row === null ? null : readText(row.thumbnailUrl))
  return { url, posterUrl }
}

/**
 * 投影单个画布节点。
 * @param node - 画布节点快照。
 * @returns 引用候选；非媒体节点或缺少真实资产时为 null。
 */
function candidateForNode(node: TapCanvasNodeSnapshot): TapCanvasAssetCandidate | null {
  const data = node.data
  const kindText = readText(data.kind)
  if (kindText === null) return null
  const label = readText(data.label) ?? node.id
  if (IMAGE_KINDS.has(kindText)) {
    const url = readImageUrl(data)
    return url === null ? null : { nodeId: node.id, kind: 'image', label, url, posterUrl: null }
  }
  if (VIDEO_KINDS.has(kindText)) {
    const asset = readVideoAsset(data)
    return asset === null
      ? null
      : { nodeId: node.id, kind: 'video', label, url: asset.url, posterUrl: asset.posterUrl }
  }
  return null
}

/**
 * 把画布快照投影成有序的引用候选。
 *
 * 只有同时具备真实媒体 URL 与可识别 kind 的节点才会出现；其余节点不进入菜单，
 * 因为把没有真实资产的节点列出来只会让用户引用到一个必然失败的目标。
 * @param scope - 当前画布作用域（可能尚未同步）。
 * @returns 按画布节点顺序排列的候选。
 */
export function listTapCanvasAssetCandidates(scope: TapCanvasScope | null): readonly TapCanvasAssetCandidate[] {
  if (scope?.canvas == null) return []
  const candidates: TapCanvasAssetCandidate[] = []
  for (const node of scope.canvas.nodes) {
    const candidate = candidateForNode(node)
    if (candidate !== null) candidates.push(candidate)
  }
  return candidates
}

/**
 * 把候选 URL 解析成可请求的绝对地址。
 *
 * 画布资产 URL 有两种形态：对象存储的绝对地址，以及画布自身 origin 下的相对
 * 路径。Agent 页面与画布页面不同源，相对路径必须回到画布 origin，否则会打到
 * Agent 自己的路由上。既不是绝对 http/https、也没有可用画布 origin 时返回
 * null，由调用方显式失败；`blob:` / `data:` 这类绑定创建页面的地址同样返回
 * null，绝不伪装成可用资产。
 * @param url - 候选里的原始 URL。
 * @param canvasOrigin - 画布页面 origin；未知时为 null。
 * @returns 绝对 http/https URL，或 null。
 */
export function resolveTapCanvasAssetUrl(url: string, canvasOrigin: string | null): string | null {
  const trimmed = url.trim()
  if (trimmed === '') return null
  if (/^https?:\/\//iu.test(trimmed)) return trimmed
  if (trimmed.startsWith('/')) {
    if (canvasOrigin === null) return null
    try {
      return new URL(trimmed, canvasOrigin).toString()
    } catch {
      return null
    }
  }
  return null
}
