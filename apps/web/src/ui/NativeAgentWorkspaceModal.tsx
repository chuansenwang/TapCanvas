import React from 'react'
import { Modal } from '@mantine/core'
import { useUIStore } from './uiStore'
import './NativeAgentWorkspaceModal.css'

/**
 * 在 TapCanvas 的当前页面内承载 Harness 原生工作区。
 * `/agent/` 与画布使用同一个浏览器 Origin，由 Harness Web Server 提供。
 */
export function NativeAgentWorkspaceModal(): JSX.Element {
  const opened = useUIStore((state) => state.nativeAgentWorkspaceOpen)
  const close = useUIStore((state) => state.closeNativeAgentWorkspace)

  return (
    <Modal
      className="native-agent-workspace-modal"
      opened={opened}
      onClose={close}
      title="导演小T"
      size="calc(100vw - 48px)"
      centered
      zIndex={10_500}
      overlayProps={{ backgroundOpacity: 0.42, blur: 2 }}
    >
      <div className="native-agent-workspace-modal__body">
        <iframe
          className="native-agent-workspace-modal__frame"
          src="/agent/"
          title="导演小T原生工作区"
        />
      </div>
    </Modal>
  )
}
