import { describe, expect, it } from 'vitest'
import { parseTapCanvasScope, parseTapCanvasScopeMessage } from '../src/client/tapcanvasScope.ts'

describe('TapCanvas scope bridge', () => {
  it('normalizes a structured scope message', () => {
    expect(parseTapCanvasScopeMessage({
      type: 'tapcanvas:scope',
      scope: {
        projectId: ' project-1 ',
        projectName: '项目一',
        flowId: '',
        chapterId: 'chapter-2',
        chapterTitle: '第二章',
        bookId: null,
        selectedNodeIds: ['node-1', ' ', 2, 'node-2'],
        canvas: {
          nodes: [{ id: 'n1', type: 'image', position: { x: 1, y: 2 }, data: { label: '节点' } }],
          edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
        },
      },
    })).toEqual({
      type: 'tapcanvas:scope',
      scope: {
        projectId: 'project-1',
        projectName: '项目一',
        flowId: null,
        chapterId: 'chapter-2',
        chapterTitle: '第二章',
        bookId: null,
        selectedNodeIds: ['node-1', 'node-2'],
        canvas: {
          nodes: [{ id: 'n1', type: 'image', position: { x: 1, y: 2 }, data: { label: '节点' } }],
          edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: null, targetHandle: null }],
        },
      },
    })
  })

  it('rejects messages from another protocol', () => {
    expect(parseTapCanvasScopeMessage({ type: 'other', scope: {} })).toBeNull()
    expect(parseTapCanvasScopeMessage({ type: 'tapcanvas:scope', scope: {} })).toBeNull()
    expect(parseTapCanvasScope(null)).toBeNull()
  })
})
