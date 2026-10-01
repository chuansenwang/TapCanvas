// @vitest-environment jsdom
/**
 * Canvas asset reference coverage: what the `@` menu publishes for the current
 * canvas, how a pick renders in the draft, and — the part that must never
 * regress — that the reference's model-visible bytes ride the prompt or the
 * send fails loudly instead of degrading to a text-only mention.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  canvasReferenceToken,
  createTapCanvasCanvasReferenceSource,
  registerTapCanvasCanvasReferences,
} from '../src/client/tapcanvasCanvasReference.ts'
import { tapCanvasScopeHub, type TapCanvasScope } from '../src/client/tapcanvasScope.ts'
import { zh } from '../src/client/locales.ts'

const CANVAS_ORIGIN = 'http://127.0.0.1:5175'
const t = makeTranslate(zh, commonZh)

/** One canvas snapshot with an image node and a video node carrying a poster. */
function scopeWith(nodes: TapCanvasScope['canvas']): TapCanvasScope {
  return {
    userId: 'user-1',
    projectId: 'project-1',
    projectName: '项目一',
    flowId: 'flow-1',
    chapterId: null,
    chapterTitle: null,
    bookId: null,
    selectedNodeIds: [],
    canvas: nodes,
  }
}

const IMAGE_NODE = {
  id: 'node-image',
  type: 'taskNode',
  position: { x: 0, y: 0 },
  data: { kind: 'image', label: '角色定妆', imageUrl: 'https://oss.example.com/a.png' },
}
const VIDEO_NODE = {
  id: 'node-video',
  type: 'taskNode',
  position: { x: 0, y: 0 },
  data: {
    kind: 'video',
    label: '镜头一',
    videoUrl: 'https://oss.example.com/a.mp4',
    videoThumbnailUrl: 'https://oss.example.com/a.poster.png',
  },
}

/** Install one canvas scope view into the shared hub for the duration of a test. */
function primeScope(scope: TapCanvasScope | null, origin: string | null = CANVAS_ORIGIN): void {
  tapCanvasScopeHub.store.set(scope === null ? null : { scope, origin })
}

afterEach(() => {
  primeScope(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('canvas asset candidates', () => {
  it('publishes only nodes with a real asset URL, newest menu section first', async () => {
    primeScope(scopeWith({ nodes: [
      IMAGE_NODE,
      VIDEO_NODE,
      // 缺真实资产 URL 的媒体节点：列出来只会让用户引用到必然失败的目标。
      { id: 'node-empty', type: 'taskNode', position: { x: 0, y: 0 }, data: { kind: 'image', label: '空' } },
      // 非媒体节点不进入画布素材分组。
      { id: 'node-text', type: 'taskNode', position: { x: 0, y: 0 }, data: { kind: 'text', label: '脚本' } },
    ], edges: [] }))
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const rows = await source.candidates(
      { sessionId: 's1' },
      { query: '', signal: new AbortController().signal },
    )
    expect(rows.map(row => row.name)).toEqual(['角色定妆', '镜头一'])
    expect(rows[0]?.icon).toBe('image')
    expect(rows[1]?.icon).toBe('video')
    expect(source.order).toBe(-1)
  })

  it('filters by the typed query and stays empty without a canvas scope', async () => {
    primeScope(scopeWith({ nodes: [IMAGE_NODE, VIDEO_NODE], edges: [] }))
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const rows = await source.candidates(
      { sessionId: 's1' },
      { query: '镜头', signal: new AbortController().signal },
    )
    expect(rows.map(row => row.name)).toEqual(['镜头一'])

    primeScope(null)
    const empty = await source.candidates(
      { sessionId: 's1' },
      { query: '', signal: new AbortController().signal },
    )
    expect(empty).toEqual([])
  })

  it('hides a candidate whose URL cannot be read from the Agent page', async () => {
    // 相对路径缺画布 origin、blob 地址绑定创建它的页面：两者都取不到字节。
    primeScope(scopeWith({ nodes: [
      { id: 'n-rel', type: 'taskNode', position: { x: 0, y: 0 }, data: { kind: 'image', label: '相对', imageUrl: '/assets/a.png' } },
      { id: 'n-blob', type: 'taskNode', position: { x: 0, y: 0 }, data: { kind: 'image', label: '本地', imageUrl: 'blob:http://x/1' } },
    ], edges: [] }), null)
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const rows = await source.candidates(
      { sessionId: 's1' },
      { query: '', signal: new AbortController().signal },
    )
    expect(rows).toEqual([])
  })

  it('inserts a chip whose draft text carries the node identity', () => {
    primeScope(scopeWith({ nodes: [IMAGE_NODE], edges: [] }))
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const outcome = source.onPick({
      candidate: { name: '角色定妆', value: JSON.stringify({
        nodeId: 'node-image',
        kind: 'image',
        url: 'https://oss.example.com/a.png',
        posterUrl: null,
        title: '角色定妆',
      }) },
    })
    expect(outcome).toMatchObject({
      insert: {
        source: 'canvas',
        ref: canvasReferenceToken('image', 'node-image'),
        label: '角色定妆',
        appearance: 'image',
      },
    })
    // 草稿会被持久化后按字面回灌，文本必须自带走节点身份。
    expect(outcome?.insert.clipboardText).toContain('dsh-canvas:image:node-image')
    // 引用必须让用户看见所引用的画面本身，而不只是一个名字。
    expect(outcome?.insert.thumbnailUrl).toBe('https://oss.example.com/a.png')
  })

  it('previews a video reference with its first-frame poster', () => {
    primeScope(scopeWith({ nodes: [VIDEO_NODE], edges: [] }))
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const outcome = source.onPick({
      candidate: { name: '镜头一', value: JSON.stringify({
        nodeId: 'node-video',
        kind: 'video',
        url: 'https://oss.example.com/a.mp4',
        posterUrl: 'https://oss.example.com/a.poster.png',
        title: '镜头一',
      }) },
    })
    expect(outcome?.insert.thumbnailUrl).toBe('https://oss.example.com/a.poster.png')
  })

  it('omits the preview when no readable URL exists instead of rendering a broken image', () => {
    primeScope(scopeWith({ nodes: [IMAGE_NODE], edges: [] }), null)
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const outcome = source.onPick({
      candidate: { name: '角色定妆', value: JSON.stringify({
        nodeId: 'node-image',
        kind: 'image',
        url: '/assets/relative.png',
        posterUrl: null,
        title: '角色定妆',
      }) },
    })
    expect(outcome?.insert.thumbnailUrl).toBeUndefined()
  })

  it('drops a pick whose payload is not a canvas candidate', () => {
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    expect(source.onPick({ candidate: { name: 'x', value: 'not json' } })).toBeUndefined()
    expect(source.onPick({ candidate: { name: 'x' } })).toBeUndefined()
    expect(source.onPick({ candidate: { name: 'x', value: '{"kind":"image"}' } })).toBeUndefined()
  })
})

describe('canvas reference registration', () => {
  it('registers on the trigger pipeline once that service is available', async () => {
    const ctx = new Context()
    const unregister = vi.fn()
    const registerSource = vi.fn(() => unregister)
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    // 触发服务由 ui-input-trigger 提供，在本插件之后加载：注册必须等它出现。
    registerTapCanvasCanvasReferences(ctx, [source])
    ctx.provide('inputTriggers', { registerSource })
    await vi.waitFor(() => { expect(registerSource).toHaveBeenCalledWith(source) })
  })
})

describe('canvas asset bytes', () => {
  /** Stub global fetch with one canned response. */
  function stubFetch(response: Partial<Response> & { blobType?: string }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(() => Promise.resolve({
      ok: response.ok ?? true,
      headers: new Headers(response.blobType === undefined ? {} : { 'content-type': response.blobType }),
      blob: () => Promise.resolve(new Blob([Uint8Array.of(1, 2, 3)], { type: response.blobType ?? '' })),
    } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('delivers an image node as a real attachment file', async () => {
    primeScope(scopeWith({ nodes: [IMAGE_NODE], edges: [] }))
    const fetchMock = stubFetch({ blobType: 'image/png' })
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const files = await source.codec.attachments(
      canvasReferenceToken('image', 'node-image'),
      new AbortController().signal,
    )
    expect(fetchMock).toHaveBeenCalledWith('https://oss.example.com/a.png', expect.anything())
    expect(files).toHaveLength(1)
    expect(files[0]?.type).toBe('image/png')
    expect(files[0]?.name).toBe('角色定妆.png')
  })

  it('delivers a video node as its first-frame poster', async () => {
    primeScope(scopeWith({ nodes: [VIDEO_NODE], edges: [] }))
    const fetchMock = stubFetch({ blobType: 'image/jpeg' })
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const files = await source.codec.attachments(
      canvasReferenceToken('video', 'node-video'),
      new AbortController().signal,
    )
    expect(fetchMock).toHaveBeenCalledWith('https://oss.example.com/a.poster.png', expect.anything())
    expect(files[0]?.type).toBe('image/jpeg')
  })

  it('sends no bytes for a video node with no poster instead of inventing one', async () => {
    primeScope(scopeWith({ nodes: [{
      id: 'node-noposter',
      type: 'taskNode',
      position: { x: 0, y: 0 },
      data: { kind: 'video', label: '无封面', videoUrl: 'https://oss.example.com/b.mp4' },
    }], edges: [] }))
    const fetchMock = stubFetch({ blobType: 'image/png' })
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const files = await source.codec.attachments(
      canvasReferenceToken('video', 'node-noposter'),
      new AbortController().signal,
    )
    expect(files).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails loudly when the asset bytes are unreadable', async () => {
    primeScope(scopeWith({ nodes: [IMAGE_NODE], edges: [] }))
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)

    // 非 2xx：显式失败，绝不退化成"只有 URL"的 prompt。
    stubFetch({ ok: false, blobType: 'image/png' })
    await expect(source.codec.attachments(
      canvasReferenceToken('image', 'node-image'),
      new AbortController().signal,
    )).rejects.toThrow(/not readable as a supported image/u)

    // 不是受支持的栅格格式：同样显式失败。
    stubFetch({ blobType: 'application/octet-stream' })
    await expect(source.codec.attachments(
      canvasReferenceToken('image', 'node-image'),
      new AbortController().signal,
    )).rejects.toThrow(/not readable as a supported image/u)
  })

  it('fails loudly when the referenced node no longer exists on the canvas', async () => {
    primeScope(scopeWith({ nodes: [IMAGE_NODE], edges: [] }))
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    await expect(source.codec.attachments(
      canvasReferenceToken('image', 'node-gone'),
      new AbortController().signal,
    )).rejects.toThrow(/no longer resolves/u)
    await expect(source.codec.serialize(
      canvasReferenceToken('image', 'node-gone'),
      new AbortController().signal,
    )).rejects.toThrow(/no longer resolves/u)
  })

  it('states the video file was not delivered, and names the image node', async () => {
    primeScope(scopeWith({ nodes: [IMAGE_NODE, VIDEO_NODE], edges: [] }))
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const signal = new AbortController().signal
    const imageText = await source.codec.serialize(canvasReferenceToken('image', 'node-image'), signal)
    expect(imageText).toContain('node-image')
    expect(imageText).toContain('角色定妆')

    const videoText = await source.codec.serialize(canvasReferenceToken('video', 'node-video'), signal)
    expect(videoText).toContain('镜头一')
    expect(videoText).toContain('未直接送达视频文件')
  })

  it('keeps the clipboard projection resolvable after a remount', () => {
    primeScope(scopeWith({ nodes: [IMAGE_NODE], edges: [] }))
    const source = createTapCanvasCanvasReferenceSource(tapCanvasScopeHub, t)
    const token = canvasReferenceToken('image', 'node-image')
    const clipboard = source.codec.clipboardText(token)
    // 重挂载后回灌的就是这段文本；它必须仍带节点身份，否则图片会静默丢失。
    expect(clipboard).toContain('dsh-canvas:image:node-image')
    expect(source.codec.clipboardText('dsh-canvas:image:absent')).toContain('dsh-canvas:image:absent')
    expect(source.codec.clipboardText('unrelated')).toBe('unrelated')
  })

})
