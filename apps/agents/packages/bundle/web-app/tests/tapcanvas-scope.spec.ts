import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  FILM_FUNCTION_NAMES,
  parseFilmImageGenArguments,
  registerTapCanvasRuntime,
  tapCanvasWorkspaceKey,
  type TapCanvasScope,
} from '../src/tapcanvas-scope.ts'

const scope = (overrides: Partial<TapCanvasScope> = {}): TapCanvasScope => ({
  projectId: 'project-1',
  projectName: '项目一',
  flowId: 'flow-1',
  chapterId: 'chapter-1',
  chapterTitle: '第一章',
  bookId: 'book-1',
  selectedNodeIds: [],
  canvas: null,
  ...overrides,
})

describe('TapCanvas 工作区绑定', () => {
  it('同一画布作用域生成稳定键，字段空值不会产生不确定结果', () => {
    expect(tapCanvasWorkspaceKey(scope())).toBe(tapCanvasWorkspaceKey(scope()))
    expect(tapCanvasWorkspaceKey(scope({ projectName: '另一个名称' })))
      .toBe(tapCanvasWorkspaceKey(scope()))
  })

  it('不同画布作用域生成不同键，避免会话和工作区串用', () => {
    expect(tapCanvasWorkspaceKey(scope({ projectId: 'project-2' })))
      .not.toBe(tapCanvasWorkspaceKey(scope()))
    expect(tapCanvasWorkspaceKey(scope({ flowId: 'flow-2' })))
      .not.toBe(tapCanvasWorkspaceKey(scope()))
  })

  it('切换画布作用域时不会将当前旧会话附加到新工作区', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'tapcanvas-scope-'))
    const originalDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    let attachCalls = 0
    const handlers = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()
    const workspace = {
      id: 'new-canvas-workspace',
      attachSession: async (_sessionId: string): Promise<void> => { attachCalls += 1 },
    }
    const ctx = {
      connection: {
        rpc: {
          handle: (path: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>): (() => void) => {
            handlers.set(path, handler)
            return () => { handlers.delete(path) }
          },
        },
      },
      sessions: { get: (_sessionId: string): object => ({}) },
      get: (name: string): unknown => name === 'workspaceRegistry'
        ? { create: async (): Promise<typeof workspace> => workspace, get: (_id: string): typeof workspace => workspace }
        : undefined,
      systemPrompt: {
        context: (_entry: unknown): void => {},
        getContextOrder: (_name: string): number => 0,
        section: (_entry: unknown): void => {},
        getSectionOrder: (_name: string): number => 0,
      },
      tools: { register: (_tool: unknown): void => {} },
    } as unknown as Context

    try {
      registerTapCanvasRuntime(ctx)
      const handler = handlers.get('/tapcanvas')
      if (handler === undefined) throw new Error('TapCanvas scope RPC handler 未注册')
      const result = await handler('scope', {
        args: {
          sessionId: 'old-canvas-session',
          scope: scope({ projectId: `project-${randomUUID()}` }),
        },
      })

      expect(result).toMatchObject({ ok: true })
      expect(attachCalls).toBe(0)
    } finally {
      if (originalDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalDshHome
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})

describe('影视原生 Function 契约', () => {
  it('图片生成必须显式选择执行器，避免本地模型隐式进入 new-api', () => {
    expect(() => parseFilmImageGenArguments({ prompt: '一只小狗' })).toThrow('vendor 必须明确指定')
    expect(parseFilmImageGenArguments({ prompt: '一只小狗', vendor: 'comfyui', ai_model: 'z-image' }))
      .toMatchObject({ prompt: '一只小狗', vendor: 'comfyui', ai_model: 'z-image' })
  })

  it('包含附件主工具及任务管理展开函数', () => {
    expect(FILM_FUNCTION_NAMES).toEqual(expect.arrayContaining([
      'film_image_gen',
      'film_video_gen',
      'film_video_composite',
      'film_scene_director',
      'film_video_edit',
      'film_ask_human',
      'film_memory_recall',
      'film_file_write',
      'film_file_read',
      'film_task_create',
      'film_task_update',
      'film_task_list',
      'film_task_read',
    ]))
    expect(FILM_FUNCTION_NAMES).toHaveLength(18)
  })
})
