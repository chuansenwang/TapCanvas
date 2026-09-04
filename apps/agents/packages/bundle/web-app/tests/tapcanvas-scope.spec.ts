import { describe, expect, it } from 'vitest'
import { tapCanvasWorkspaceKey, type TapCanvasScope } from '../src/tapcanvas-scope.ts'

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
