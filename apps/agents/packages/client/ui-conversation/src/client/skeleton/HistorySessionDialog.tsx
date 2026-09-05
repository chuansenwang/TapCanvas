import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationSlotProps } from '../contract/slots.ts'
import css from './HistorySessionDialog.module.css'

type HistoryTranslate = ConversationSlotProps['t']

interface HistorySessionDialogProps {
  readonly open: boolean
  readonly sessions: SessionListState
  readonly workspacePath: string | undefined
  readonly onClose: () => void
  readonly onOpenSession: (sessionId: SessionId) => void
  readonly t: HistoryTranslate
}

function historySessions(
  sessions: SessionListState,
  workspacePath: string | undefined,
): readonly SessionSummary[] {
  if (workspacePath === undefined) return []
  return sessions.ids.flatMap((id) => {
    const session = sessions.byId[id]
    return session?.cwd === workspacePath && !session.blank ? [session] : []
  })
}

/** Canvas-scoped Session picker used when the embedded sidebar is unavailable. */
export function HistorySessionDialog({
  open,
  sessions,
  workspacePath,
  onClose,
  onOpenSession,
  t,
}: HistorySessionDialogProps) {
  const history = historySessions(sessions, workspacePath)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('history.title')}
      closeLabel={t('history.close')}
      {...{ className: css.dialog as string, contentClassName: css.content as string }}
    >
      {history.length === 0
        ? <p className={css.empty}>{t('history.empty')}</p>
        : (
          <div className={css.list} role="list">
            {history.map(session => (
              <button
                key={session.id}
                type="button"
                className={css.row}
                aria-current={session.id === sessions.current ? 'page' : undefined}
                onClick={() => {
                  onOpenSession(session.id)
                  onClose()
                }}
              >
                {session.displayTitle}
              </button>
            ))}
          </div>
        )}
    </Modal>
  )
}
