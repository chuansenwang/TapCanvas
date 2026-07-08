import React from 'react'
import { Title, Stack, Button, Transition, Text } from '@mantine/core'
import { IconLayoutGrid, IconPhoto, IconTypography, IconVideo, IconMusic, IconScissors, IconDeviceTvOld } from '@tabler/icons-react'
import { useUIStore } from './uiStore'
import { useRFStore } from '../canvas/store'
import { $ } from '../canvas/i18n'
import { calculateSafeMaxHeight } from './utils/panelPosition'
import { PanelCard } from './PanelCard'
import { stopPanelWheelPropagation } from './utils/panelWheel'

const ADDABLE_NODE_OPTIONS = [
  { kind: 'text', label: '文本', Icon: IconTypography },
  { kind: 'image', label: '图像', Icon: IconPhoto },
  { kind: 'storyboard', label: '分镜编辑', Icon: IconLayoutGrid },
  { kind: 'video', label: '视频', Icon: IconVideo },
  { kind: 'audio-beta', label: '音频', Icon: IconMusic, badge: 'BETA', disabled: true },
  { kind: 'compose-video-beta', label: '视频合成', Icon: IconScissors, badge: 'BETA', disabled: true },
  { kind: 'director-beta', label: '导演台', Icon: IconDeviceTvOld, badge: 'BETA', disabled: true },
] as const

export default function AddNodePanel({ className }: { className?: string }): JSX.Element | null {
  const active = useUIStore(s => s.activePanel)
  const setActivePanel = useUIStore(s => s.setActivePanel)
  const anchorY = useUIStore(s => s.panelAnchorY)
  const addNode = useRFStore(s => s.addNode)

  const mounted = active === 'add'
  const maxHeight = calculateSafeMaxHeight(anchorY, 120)
  const panelClassName = ['add-node-panel', className].filter(Boolean).join(' ')
  const addTaskNode = React.useCallback((kind: string) => {
    addNode('taskNode', undefined, { kind })
    setActivePanel(null)
  }, [addNode, setActivePanel])

  return (
    <div className={panelClassName} style={{ position: 'fixed', inset: 0, zIndex: 340, pointerEvents: mounted ? 'auto' : 'none' }} data-ux-panel>
      <Transition className="add-node-panel-transition" mounted={mounted} transition="pop" duration={140} timingFunction="ease">
        {(styles) => (
          <div className="add-node-panel-transition-inner" style={{ ...styles, position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 132 }}>
            <PanelCard
              className="add-node-panel-shell"
              style={{
                width: 480,
                maxWidth: 'calc(100vw - 32px)',
                maxHeight: `${Math.max(320, maxHeight)}px`,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                transformOrigin: 'center bottom',
              }}
              onWheelCapture={stopPanelWheelPropagation}
              data-ux-panel
            >
              <div className="add-node-panel-body" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                <Title className="add-node-panel-title" order={3} mb={14}>{$('添加节点')}</Title>
                <Stack className="add-node-panel-actions" gap={12}>
                  {ADDABLE_NODE_OPTIONS.map(({ kind, label, Icon, badge, disabled }) => (
                    <Button
                      key={kind}
                      className="add-node-panel-button"
                      variant="subtle"
                      leftSection={<Icon className="add-node-panel-icon" size={16} />}
                      rightSection={badge ? <Text className="add-node-panel-badge">{badge}</Text> : null}
                      onClick={() => { if (!disabled) addTaskNode(kind) }}
                      disabled={disabled}
                    >
                      {$(label)}
                    </Button>
                  ))}
                </Stack>
              </div>
            </PanelCard>
          </div>
        )}
      </Transition>
    </div>
  )
}
