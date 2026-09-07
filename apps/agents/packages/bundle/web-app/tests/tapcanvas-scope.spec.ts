import { describe, expect, it } from 'vitest'
import { FILM_FUNCTION_NAMES, parseFilmImageGenArguments, tapCanvasWorkspaceKey, type TapCanvasScope } from '../src/tapcanvas-scope.ts'

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
