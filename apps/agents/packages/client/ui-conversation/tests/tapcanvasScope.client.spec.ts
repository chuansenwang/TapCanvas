import { describe, expect, it } from 'vitest'
import {
  parseTapCanvasScope,
  parseTapCanvasScopeMessage,
  resolveTapCanvasParentOrigin,
} from '../src/client/tapcanvasScope.ts'

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

  it('uses the embedding page origin for cross-port Agent messages', () => {
    expect(resolveTapCanvasParentOrigin(
      'http://127.0.0.1:5175/studio?projectId=project-1',
      'http://127.0.0.1:3080',
      true,
    )).toBe('http://127.0.0.1:5175')
  })

  it('keeps top-level Agent requests on its own origin', () => {
    expect(resolveTapCanvasParentOrigin('', 'http://127.0.0.1:3080', false))
      .toBe('http://127.0.0.1:3080')
  })

  it('fails closed when an embedded page has no valid referrer origin', () => {
    expect(resolveTapCanvasParentOrigin('', 'http://127.0.0.1:3080', true)).toBeNull()
    expect(resolveTapCanvasParentOrigin('not a URL', 'http://127.0.0.1:3080', true)).toBeNull()
  })
})
