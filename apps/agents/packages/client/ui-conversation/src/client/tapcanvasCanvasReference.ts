/**
 * TapCanvas 画布资产引用来源：`@` 菜单里的"当前画布"分组。
 *
 * 用户把画布上已经生成的图片或视频引用进本轮对话时：
 * - 图片直接取回字节，作为真实多模态附件随本轮 prompt 送给模型；
 * - 视频的字节模型无法直接理解，因此取回服务端已经抽好的首帧封面图作为附件，
 *   并在模型文本里如实给出节点、类型与视频地址。
 *
 * 取不到字节时一律显式失败（抛错或返回空列表），绝不静默降级成"只有一段 URL"的
 * prompt，让模型以为它看到了画面。
 *
 * 本模块通过 `ctx.inject(['inputTriggers'])` 注册来源，并且只使用结构化类型描述
 * 触发管线：`ui-input-trigger` 与本包存在单向项目引用关系，反向值导入会形成环。
 *
 * @module @deepseek-ai/dsh-client-ui-conversation/tapcanvas-canvas-reference
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  listTapCanvasAssetCandidates,
  resolveTapCanvasAssetUrl,
  type TapCanvasAssetCandidate,
} from './tapcanvasCanvasAssets.ts'
import type { TapCanvasScopeHub } from './tapcanvasScope.ts'

/** 一处画布引用在菜单里的定位载荷（对管线是不透明字符串）。 */
interface CanvasCandidateValue {
  readonly nodeId: string
  readonly kind: TapCanvasAssetCandidate['kind']
  readonly url: string
  readonly posterUrl: string | null
  readonly title: string
}

/** 触发管线与本模块共享的最小引用插入面（结构等价于 ReferenceInsert）。 */
interface CanvasReferenceInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance: 'image' | 'video'
  /** 预览画面 URL（图片原图 / 视频首帧）；解析不出时省略。 */
  readonly thumbnailUrl?: string
  readonly clipboardText: string
}

/** 触发管线的 pick 结果（本来源只产生引用插入）。 */
type CanvasPickOutcome = { readonly insert: CanvasReferenceInsert } | undefined

/** 菜单候选行（结构等价于 InputTriggerCandidate）。 */
interface CanvasMenuRow {
  readonly name: string
  readonly description?: string
  readonly icon?: 'image' | 'video'
  readonly section?: string
  readonly value?: string
}

/** 触发来源注册面（结构声明，避免反向值导入）。 */
interface CanvasTriggerSource {
  readonly trigger: '@'
  readonly name: string
  readonly order?: number
  readonly showGroupTitle?: boolean
  candidates(
    session: { readonly sessionId: string },
    req: { readonly query: string; readonly signal: AbortSignal },
  ): Promise<readonly CanvasMenuRow[]>
  onPick(pick: { readonly candidate: CanvasMenuRow }): CanvasPickOutcome
  readonly codec: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
    attachments(ref: string, signal: AbortSignal): Promise<readonly File[]>
  }
}

/** 触发服务面（结构声明）：只用到注册与解注册。 */
interface CanvasTriggerRegistry {
  registerSource(source: CanvasTriggerSource): () => void
}

/** 引用在草稿与剪贴板里的稳定标识；刻意不以 `@`/`/` 开头，避免被当成路径引用。 */
export function canvasReferenceToken(kind: TapCanvasAssetCandidate['kind'], nodeId: string): string {
  return `dsh-canvas:${kind}:${nodeId}`
}

/**
 * 引用的显示与持久化文本。
 *
 * 折叠由呈现层按 `@[label](dsh-canvas:<kind>:<id>)` 完成；草稿复原时该文本
 * 自带走节点身份，因此重挂载后引用仍然指向同一张画布资产。方括号是 wire 语法
 * 的分隔符，标签里的它们必须转义，否则引用文本会解析失败。
 * @param kind - 资产类型。
 * @param label - 用户可见标签。
 * @param nodeId - 画布节点 ID。
 * @returns wire 形式的引用文本。
 */
export function canvasWireToken(
  kind: TapCanvasAssetCandidate['kind'],
  label: string,
  nodeId: string,
): string {
  return `@[${label.replace(/[[\]\n]/gu, ' ')}](dsh-canvas:${kind}:${nodeId})`
}

/**
 * 解析一处画布引用的定位载荷。
 * @param ref - 引用文本。
 * @returns 载荷，或 null（文本不是本来源产生的形式）。
 */
export function parseCanvasReference(ref: string): { kind: TapCanvasAssetCandidate['kind']; nodeId: string } | null {
  const match = /^dsh-canvas:(image|video):(.+)$/u.exec(ref.trim())
  if (match === null) return null
  const nodeId = match[2]?.trim() ?? ''
  if (nodeId === '') return null
  return { kind: match[1] as TapCanvasAssetCandidate['kind'], nodeId }
}

/** 媒体类型到文件扩展名的映射，只覆盖画布与附件服务都接受的栅格格式。 */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * 取回一个画布资产的字节，作为附件文件。
 *
 * 返回 null 表示"这个地址取不到可用的模型可见字节"（跨源被拒、非 2xx、内容不是
 * 受支持的栅格图片）。调用方据此显式失败或如实说明，不会拿到半份数据。
 * @param url - 已解析成绝对地址的画布资产 URL。
 * @param fallbackName - 文件显示名（节点标题或节点 ID）。
 * @param signal - 本轮提交的取消信号。
 * @returns 可交给附件服务的文件，或 null。
 */
async function fetchCanvasAssetFile(
  url: string,
  fallbackName: string,
  signal: AbortSignal,
): Promise<File | null> {
  const response = await fetch(url, { signal })
  if (!response.ok) return null
  const blob = await response.blob()
  const mediaType = (blob.type || response.headers.get('content-type') || '').split(';')[0]?.trim().toLowerCase() ?? ''
  const extension = EXTENSION_BY_MEDIA_TYPE[mediaType]
  if (extension === undefined) return null
  const safeName = fallbackName.replace(/[\\/:*?"<>|\n\r\t]+/gu, '_').slice(0, 120) || 'canvas-asset'
  return new File([blob], `${safeName}.${extension}`, { type: mediaType })
}

/**
 * 构造一条画布引用来源。
 * @param hub - 画布作用域来源（含画布页面 origin）。
 * @param t - 会话命名空间字典。
 * @returns 可注册到 `ctx.inputTriggers` 的来源。
 */
export function createTapCanvasCanvasReferenceSource(
  hub: TapCanvasScopeHub,
  t: TranslateNS<'conversation'>,
): CanvasTriggerSource {
  /** 把当前作用域投影成候选；没有作用域时不产生任何候选。 */
  const candidatesOf = (query: string): readonly TapCanvasAssetCandidate[] => {
    const view = hub.store.getSnapshot()
    const all = listTapCanvasAssetCandidates(view?.scope ?? null)
    const needle = query.trim().toLowerCase()
    if (needle === '') return all
    return all.filter(candidate => candidate.label.toLowerCase().includes(needle))
  }

  /** 从候选定位载荷还原一处引用。 */
  const parseValue = (value: string | undefined): CanvasCandidateValue | null => {
    if (value === undefined) return null
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const record = parsed as Record<string, unknown>
      const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : ''
      const kind = record.kind === 'image' || record.kind === 'video' ? record.kind : null
      const url = typeof record.url === 'string' ? record.url.trim() : ''
      const title = typeof record.title === 'string' ? record.title : ''
      if (nodeId === '' || kind === null || url === '') return null
      return {
        nodeId,
        kind,
        url,
        posterUrl: typeof record.posterUrl === 'string' && record.posterUrl.trim() !== ''
          ? record.posterUrl
          : null,
        title,
      }
    } catch {
      return null
    }
  }

  /** 解析一处引用对应候选在当前画布上的事实；候选已消失时返回 null。 */
  const candidateOf = (ref: string): TapCanvasAssetCandidate | null => {
    const parsed = parseCanvasReference(ref)
    if (parsed === null) return null
    const view = hub.store.getSnapshot()
    return listTapCanvasAssetCandidates(view?.scope ?? null)
      .find(candidate => candidate.nodeId === parsed.nodeId && candidate.kind === parsed.kind) ?? null
  }

  return {
    trigger: '@',
    name: 'canvas',
    // 画布素材排在文件/会话之前：它就是用户此刻正在看的画面。
    order: -1,
    showGroupTitle: false,
    candidates(_session, req) {
      const view = hub.store.getSnapshot()
      const canvasOrigin = view?.origin ?? null
      const rows: CanvasMenuRow[] = []
      for (const candidate of candidatesOf(req.query)) {
        // 只有能解析成绝对地址的候选才进菜单：相对地址缺画布 origin、blob 地址
        // 绑定了创建它的页面，两类都无法被 Agent 读取，列出来只会让用户引用到
        // 一个必然失败的目标。
        if (resolveTapCanvasAssetUrl(candidate.url, canvasOrigin) === null) continue
        const value: CanvasCandidateValue = {
          nodeId: candidate.nodeId,
          kind: candidate.kind,
          url: candidate.url,
          posterUrl: candidate.posterUrl,
          title: candidate.label,
        }
        rows.push({
          name: candidate.label,
          description: candidate.kind === 'video' ? t('canvas.video') : t('canvas.image'),
          icon: candidate.kind,
          section: t('canvas.section'),
          value: JSON.stringify(value),
        })
      }
      return Promise.resolve(rows)
    },
    onPick(pick) {
      const value = parseValue(pick.candidate.value)
      if (value === null) return undefined
      const ref = canvasReferenceToken(value.kind, value.nodeId)
      const name = value.title === '' ? value.nodeId : value.title
      // 引用的画面就是用户此刻想看的东西：图片给原图，视频给已抽好的首帧。
      // 只有能解析成绝对地址的才作为预览，否则退回字形图标，不显示破图。
      const view = hub.store.getSnapshot()
      const canvasOrigin = view?.origin ?? null
      const previewSource = value.kind === 'video' ? value.posterUrl : value.url
      const thumbnailUrl = previewSource === null
        ? null
        : resolveTapCanvasAssetUrl(previewSource, canvasOrigin)
      return {
        insert: {
          source: 'canvas',
          ref,
          label: name,
          appearance: value.kind,
          ...(thumbnailUrl === null ? {} : { thumbnailUrl }),
          clipboardText: canvasWireToken(value.kind, name, value.nodeId),
        },
      }
    },
    codec: {
      /**
       * 草稿与剪贴板里的 wire 形式。
       *
       * 草稿会被持久化并在重挂载时按字面回灌，所以文本必须自带走节点身份：
       * 只存一个显示名的话，回来之后既变不成 chip、也解析不出该引用的是哪张图，
       * 模型就会在没有任何提示的情况下丢掉图片。wire 形式在消息气泡里由呈现层
       * 折叠成 chip，用户看到的仍是标签。
       */
      clipboardText(ref) {
        const parsed = parseCanvasReference(ref)
        if (parsed === null) return ref
        const view = hub.store.getSnapshot()
        const candidate = listTapCanvasAssetCandidates(view?.scope ?? null)
          .find(item => item.nodeId === parsed.nodeId && item.kind === parsed.kind)
        const name = candidate?.label ?? parsed.nodeId
        return canvasWireToken(parsed.kind, name, parsed.nodeId)
      },
      /**
       * 模型侧的事实形式。
       *
       * 输出与草稿同一的 wire 形式：模型据此拿到节点身份，呈现层把它折叠成
       * 可读 chip，两边看到的是同一件事。
       *
       * 图片的字节作为附件随本轮请求一起送达；视频的字节模型读不了，因此
       * 附加一行说明只送达了首帧，不制造"已经看过视频"的错觉。
       */
      serialize(ref) {
        const candidate = candidateOf(ref)
        if (candidate === null) {
          return Promise.reject(new Error(`canvas reference "${ref}" no longer resolves on the current canvas`))
        }
        const wire = canvasWireToken(candidate.kind, candidate.label, candidate.nodeId)
        return Promise.resolve(candidate.kind === 'video'
          ? `${wire}\n${t('canvas.fact.video', { name: candidate.label, nodeId: candidate.nodeId })}`
          : wire)
      },
      /**
       * 取回该引用要交给模型的字节。
       *
       * 图片取原图；视频取服务端已抽好的首帧封面。地址在提交时刻重新解析，因此
       * 引用之后节点被重新生成也仍然指向当前真实资产。取不到字节时抛错，让本轮
       * 发送显式失败，而不是让模型以为附件已经送达。
       */
      async attachments(ref, signal) {
        const candidate = candidateOf(ref)
        if (candidate === null) {
          throw new Error(`canvas reference "${ref}" no longer resolves on the current canvas`)
        }
        const view = hub.store.getSnapshot()
        const canvasOrigin = view?.origin ?? null
        const source = candidate.kind === 'video' ? candidate.posterUrl : candidate.url
        if (source === null) return []
        const assetUrl = resolveTapCanvasAssetUrl(source, canvasOrigin)
        if (assetUrl === null) {
          throw new Error(`canvas reference "${ref}" has no readable asset URL`)
        }
        const file = await fetchCanvasAssetFile(assetUrl, candidate.label, signal)
        if (file === null) {
          throw new Error(`canvas reference "${ref}" asset bytes are not readable as a supported image`)
        }
        return [file]
      },
    },
  }
}

/**
 * 把画布引用来源挂到触发管线上。
 *
 * `inputTriggers` 由 `ui-input-trigger` 提供，而该插件在本包之后加载，因此这里
 * 用 `ctx.inject` 等它出现再注册；注册与解注册都随本插件的 fiber 生命周期。
 * @param ctx - 客户端根上下文。
 * @param sources - 已构造的来源列表。
 */
export function registerTapCanvasCanvasReferences(
  ctx: Context,
  sources: readonly CanvasTriggerSource[],
): void {
  ctx.inject(['inputTriggers'], (injected) => {
    const registry = injected.get('inputTriggers') as CanvasTriggerRegistry | undefined
    if (registry === undefined) return
    for (const source of sources) {
      injected.effect(() => registry.registerSource(source), `ui-conversation: canvas reference "${source.name}"`)
    }
  })
}
