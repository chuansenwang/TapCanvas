/**
 * Visual body of one inline reference chip: the DecoratorNode's React
 * face. Pure display — identity, invalidation, and lifecycle live on the
 * ReferenceChipNode; this component renders whatever the node carries.
 */
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { ReferenceIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReferenceIconKind } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ReferenceChip.module.css'

/** Display inputs of one chip (the node's cached owner projections). */
export interface ReferenceChipProps {
  readonly label: string
  /** Domain glyph; absent renders the trigger marker instead of an icon. */
  readonly appearance?: ReferenceIconKind | undefined
  /** Preview URL for a picture-bearing reference; absent renders the glyph alone. */
  readonly thumbnailUrl?: string | undefined
  /** Owner-resolution failure styling bit. */
  readonly invalid: boolean
}

/**
 * Render one inline reference chip.
 * @param props - label, optional domain glyph, and the invalid bit.
 * @returns the chip body (icon + truncating label).
 */
export function ReferenceChip({ label, appearance, thumbnailUrl, invalid }: ReferenceChipProps): ReactNode {
  // A failed preview must not look like an attached picture: the fetch can be
  // blocked by the asset host, so fall back to the domain glyph on error.
  const [previewFailed, setPreviewFailed] = useState(false)
  const showPreview = thumbnailUrl !== undefined && thumbnailUrl !== '' && !previewFailed
  return (
    <span className={clsx(css.chip, invalid && css.invalid)} title={label}>
      {showPreview
        ? (
          <img
            className={css.thumbnail}
            src={thumbnailUrl}
            alt=""
            aria-hidden
            onError={() => { setPreviewFailed(true) }}
          />
        )
        : appearance === undefined
          ? <span className={css.marker} aria-hidden>@</span>
          : <ReferenceIcon kind={appearance} size={14} className={css.icon} />}
      <span className={css.label}>{label}</span>
    </span>
  )
}
