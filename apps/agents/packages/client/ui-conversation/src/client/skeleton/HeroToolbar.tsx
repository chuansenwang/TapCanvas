import {
  IconFullscreenOutline16, IconNewChatOutline16, IconPanelLeftOutline16,
  IconPlusOutline16, IconClockOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationSlotProps } from '../contract/slots.ts'
import css from './HeroToolbar.module.css'

type HeroTranslate = ConversationSlotProps['t']

function isEmbedded(): boolean {
  return window.parent !== window
    || new URLSearchParams(window.location.search).get('embedded') === '1'
}

function dispatchToolbarEvent(
  type: 'dsh:toggle-sidebar' | 'dsh:new-session' | 'dsh:open-settings',
): void {
  window.dispatchEvent(new CustomEvent(type))
  if (window.parent !== window) window.parent.postMessage({ type: `tapcanvas:${type.slice(4)}` }, window.location.origin)
}

function toggleFullscreen(): void {
  if (document.fullscreenElement !== null) {
    void document.exitFullscreen()
    return
  }
  const root = document.documentElement
  if (root.requestFullscreen !== undefined) void root.requestFullscreen()
}

/** Compact hero-only chrome matching the native Agent entry surface. */
export function HeroToolbar({
  t,
  onNewSession,
  onOpenHistory,
}: {
  t: HeroTranslate
  onNewSession?: (() => void) | undefined
  onOpenHistory: () => void
}) {
  const embedded = isEmbedded()
  return (
    <header className={css.root} data-hero-toolbar data-embedded={embedded || undefined}>
      <div className={css.leading}>
        {!embedded && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('hero.nav.toggleSidebar')}
            onClick={() => { dispatchToolbarEvent('dsh:toggle-sidebar') }}
          >
            <IconPanelLeftOutline16 size={18} />
          </button>
        )}
        <button
          type="button"
          className={css.newSession}
          aria-label={t('hero.nav.newSession')}
          onClick={() => {
            onNewSession?.()
            dispatchToolbarEvent('dsh:new-session')
          }}
        >
          <span>{t('hero.nav.newSession')}</span>
          <IconNewChatOutline16 size={16} />
        </button>
      </div>
      <div className={css.trailing}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('hero.nav.status')}
          onClick={onOpenHistory}
        >
          <IconClockOutline16 size={18} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('hero.nav.add')}
          onClick={() => { document.querySelector<HTMLElement>('[contenteditable="true"]')?.focus() }}
        >
          <IconPlusOutline16 size={18} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('hero.nav.fullscreen')}
          onClick={toggleFullscreen}
        >
          <IconFullscreenOutline16 size={18} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('hero.nav.settings')}
          onClick={() => { dispatchToolbarEvent('dsh:open-settings') }}
        >
          <IconSettingsOutline16 size={18} />
        </button>
      </div>
    </header>
  )
}
