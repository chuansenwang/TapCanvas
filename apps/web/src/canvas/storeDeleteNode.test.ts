import { beforeEach, describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import { useRFStore } from './store'

function taskNode(id: string, data: Record<string, unknown> = {}): Node {
  return {
    id,
    type: 'taskNode',
    position: { x: 0, y: 0 },
    data: { kind: 'text', label: id, ...data },
  }
}

describe('deleteNode 删除结果', () => {
  beforeEach(() => {
    useRFStore.setState({
      nodes: [
        taskNode('protected', { locked: true, readOnly: true }),
        taskNode('normal'),
      ],
      edges: [{ id: 'edge', source: 'protected', target: 'normal' }],
      historyPast: [],
      historyFuture: [],
    })
  })

  it('受保护节点不删除并返回 false', () => {
    const before = useRFStore.getState().nodes

    expect(useRFStore.getState().deleteNode('protected')).toBe(false)
    expect(useRFStore.getState().nodes).toBe(before)
    expect(useRFStore.getState().edges).toHaveLength(1)
  })

  it('普通节点删除并清理关联连线，返回 true', () => {
    expect(useRFStore.getState().deleteNode('normal')).toBe(true)
    expect(useRFStore.getState().nodes.map((node) => node.id)).toEqual(['protected'])
    expect(useRFStore.getState().edges).toEqual([])
  })

  it('节点不存在时返回 false且不改变画布', () => {
    const beforeNodes = useRFStore.getState().nodes
    const beforeEdges = useRFStore.getState().edges

    expect(useRFStore.getState().deleteNode('missing')).toBe(false)
    expect(useRFStore.getState().nodes).toBe(beforeNodes)
    expect(useRFStore.getState().edges).toBe(beforeEdges)
  })
})
