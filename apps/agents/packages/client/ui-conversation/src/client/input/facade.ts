/**
 * SessionInput shell: owns the per-session Lexical editor (text + chip
 * truth) and the pure SubmitMachine (phase/claim/attempt), and choreographs
 * everything between them — projections and InputState publication, the
 * scoped-event application verbs, the submit transaction plumbing
 * (adjudicate via the session's InputTriggerController; claim.submit; default
 * sink), the notice channel, and the draft persistence mirror.
 * Package-private; the hub alone constructs it and wires the scoped event
 * listeners onto it.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  createSnapshotStore, type ObservableSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { LexicalEditor, NodeKey } from 'lexical'
import {
  $addUpdateTag, $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection,
  CLEAR_HISTORY_COMMAND, createEditor, HISTORY_MERGE_TAG, PASTE_TAG,
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { mergeRegister } from '@lexical/utils'
import type {
  ArbitrateKey, ArbitrateOutcome, CommandClaim, ConsumeTokenRequest, DraftAttachmentId,
  InputActions, InputEffect, InputNotice, InputState, InputTriggerController, PickOutcome,
  Occurrence, QueuedMessage, ReferenceInsert, SessionInput, SubmitAttempt, SubmitAttachment,
  SubmitOutcome, TokenSpan,
} from '../contract/input.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import { SubmitMachine } from './machine.ts'
import { ReferenceChipNode, $createReferenceChipNode } from './editor/chip-node.tsx'
import { refreshClaimDecoration, registerClaimDecoration } from './editor/claim-decor.ts'
import { registerTextRefDecoration, rescanTextRefs, TextRefNode } from './editor/text-ref.ts'
import type { EditorProjection } from './editor/projection.ts'
import { $composerLayout, $projectComposer, detectOffsetOfClipboardOffset } from './editor/projection.ts'
import { $replaceDetectSpanWithNodes, $replaceDetectSpanWithText } from './editor/span-map.ts'

/** Popup face the shell needs (dismissal only; typed structurally to avoid a value import). */
export interface PopupDismissFace {
  dismiss(): void
}

/**
 * Construction dependencies of one facade. The slash/popup faces are THUNKS: the
 * shell is created inside the sessions provide materialization (before the
 * scope record is queryable), where `slash.sessionOf`/`command.popupFor`
 * cannot resolve yet — resolution defers to first interactive use.
 */
export interface SessionInputDeps {
  /** Session-scope ctx handed to claim.submit transactions. */
  actx: Context
  /** Enter adjudication face resolver; absent/undefined answer = every '/' line falls to the default sink. */
  inputTriggers?: (() => InputTriggerController | undefined) | undefined
  /** PopupSelect shell face resolver (dismissal on submit lock / escape). */
  popup?: (() => PopupDismissFace | undefined) | undefined
  /** Queue read face; overlaid onto InputState.queue (absent = empty). */
  queue?: ObservableSnapshot<readonly QueuedMessage[]> | undefined
  /**
   * Steer every still-pending queued message into the running turn, in FIFO
   * order (the empty-draft accelerated-Enter gesture); absent = unsupported.
   */
  steerQueue?: (() => void) | undefined
  /** The plain-message sink (send choreography / materialize fork — the hub owns it). */
  defaultSink(
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
  ): Promise<SubmitOutcome>
  /**
   * Register reference-derived files as draft attachments and answer their ids.
   *
   * A reference source may resolve model-visible bytes (a board image). Those
   * files enter the same draft registry ordinary attachments use, so the send
   * path encodes them identically and the Host admission limits apply
   * unchanged. Absent = no source can contribute bytes (text-only references).
   */
  deriveAttachments?(files: readonly File[]): readonly DraftAttachmentId[]
  /**
   * Free reference-derived attachments that will never be sent.
   *
   * They are not part of the user's rail, so a failed or abandoned send drops
   * them outright: the chip stays in the draft and resolves its bytes again on
   * the next attempt. Absent = nothing to free.
   */
  releaseAttachments?(ids: readonly DraftAttachmentId[]): void
  /** Command-plane attachment plumbing (the hub owns the conversation face and the copy). */
  commandAttachments: {
    /** Resolve ordered draft ids to wire payloads without sending them; rejects when an id no longer resolves. */
    serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitAttachment[]>
    /** Free consumed draft attachments after a successful command submit. */
    release(ids: readonly DraftAttachmentId[]): void
    /** Localized composer notice for a claimed command that does not accept attachments. */
    unsupportedNotice(token: string): string
  }
}

/** Guard tier from the machine phase. */
function guardOf(phase: InputState['phase']): 'plain' | 'claimed' | 'frozen' {
  switch (phase) {
    case 'plain': return 'plain'
    case 'claimed': return 'claimed'
    default: return 'frozen' // adjudicating / submitting
  }
}

/** Whether two projections differ in content (selection and caret excluded). */
function projectionContentChanged(prev: EditorProjection, next: EditorProjection): boolean {
  if (prev.clipboardText !== next.clipboardText || prev.detectText !== next.detectText) return true
  if (prev.occurrences.length !== next.occurrences.length) return true
  return next.occurrences.some((occ, i) => {
    const old = prev.occurrences[i]
    return old === undefined || old.occurrenceId !== occ.occurrenceId || old.invalid !== occ.invalid
  })
}

const EMPTY_QUEUE: readonly QueuedMessage[] = []

/** No-pipeline lexicon: zero text-ref decorations. */
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/**
 * Detect-projection and legacy reference placeholders stripped from every
 * external text entering the document (paste, persisted-draft seed): a chip
 * is the only legitimate source of U+FFFC in the detect projection, so a
 * literal one in text would forge chip positions.
 */
const REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/gu

/** Undo merge window for contiguous typing, in ms (the old machine's mergeWindowMs). */
const HISTORY_MERGE_DELAY_MS = 1000

/**
 * 草稿文本里持久化的引用 wire 形式。
 *
 * 草稿按剪贴板文本持久化，重挂载后回灌的是字面文本而不是 chip 节点。若提交时
 * 只看 chip 出现点，这些引用会以"看起来正常、其实没有附件"的形式发出去。这里
 * 扫出它们，让持久化过的引用与刚插入的 chip 走同一条附件解析路径。
 */
const PERSISTED_REFERENCE_RE = /@\[[^\]\n]*\]\((dsh-[a-z0-9-]+:[^)\s]+)\)/gu

/**
 * 从草稿文本里提取仍带附件语义的持久化引用，跳过已被 chip 覆盖的范围。
 *
 * 覆盖判断按字符区间：一处 chip 与它自己的 wire 文本占据同一段草稿，若不排除
 * 就会把同一张图解析两次、重复附加。
 * @param draft - 剪贴板投影的草稿文本。
 * @param covered - 已由 chip 出现的区间（offset + length）。
 * @returns 每处未覆盖引用的来源名与其 owner-scoped ref，按出现顺序。
 */
function scanPersistedReferences(
  draft: string,
  covered: readonly { readonly offset: number; readonly length: number }[],
  contributesAttachments: (source: string) => boolean,
): readonly { source: string; ref: string; offset: number; length: number }[] {
  const found: { source: string; ref: string; offset: number; length: number }[] = []
  PERSISTED_REFERENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PERSISTED_REFERENCE_RE.exec(draft)) !== null) {
    const ref = match[1]
    if (ref === undefined) continue
    const start = match.index
    const end = start + match[0].length
    if (covered.some(range => start >= range.offset && end <= range.offset + range.length)) continue
    // 方案前缀的后半段就是来源名（`dsh-canvas:...` → `canvas`）。
    const separator = ref.indexOf(':')
    const source = separator < 0 ? '' : ref.slice(4, separator)
    if (source === '') continue
    // 只有会贡献字节的来源才需要这条补救路径：会话、文件等纯文本引用在草稿里
    // 就是文本，按原样交给模型即可，替它们多做一次解析只会凭空制造失败。
    if (!contributesAttachments(source)) continue
    found.push({ source, ref, offset: start, length: match[0].length })
  }
  return found
}

/** Editor and attachment snapshot owned by one detached default send. */
interface DetachedDraft {
  readonly draft: string
  readonly occurrences: readonly Occurrence[]
  readonly attachmentIds: readonly DraftAttachmentId[]
  /**
   * 引用来源在本轮贡献的附件 id。
   *
   * 它们属于「这一次引用」而不是用户附件栏：失败时释放（由引用本身在重试时
   * 重新贡献），成功时随发送一起被 Host 认领，绝不混入草稿栏。
   */
  derivedAttachmentIds: DraftAttachmentId[]
}

/**
 * The per-session input facade: scoped-event application verbs +
 * setDraft/submit + the published InputState store, over a shell-owned
 * Lexical editor.
 */
export class SessionInputShell implements SessionInput {
  /** Published editor projection + submit-plane state + queue overlay (the InputZone currency source). */
  readonly state: SnapshotStore<InputState>
  /** Latest surfaced notice (null after clear); the bar renders errors as banners and information inline. */
  readonly notices: SnapshotStore<InputNotice | null> = createSnapshotStore<InputNotice | null>(null)
  /** The shell-owned editor (text + chip truth); the composer binds its contenteditable to it. */
  readonly editor: LexicalEditor
  /** The public provide-channel action face (one stable identity per session). */
  readonly actions: InputActions = {
    setDraft: (text) => { this.setDraft(text) },
    addAttachments: ids => this.addAttachments(ids),
    removeAttachment: (id) => { this.removeAttachment(id) },
    pruneAttachments: (ids) => { this.pruneAttachments(ids) },
    submit: () => { this.submit('queue') },
  }

  private readonly core = new SubmitMachine()
  private projection: EditorProjection = { detectText: '', clipboardText: '', occurrences: [], selection: null, caret: null }
  private rev = 0
  /** Stable occurrence ids per chip NodeKey (undo restores keys, so ids survive it too). */
  private readonly occurrenceIds = new Map<NodeKey, number>()
  private occurrenceSeq = 0
  private readonly unregister: () => void
  private noticeSeq = 0
  private lastMirroredDraft = ''
  private attachmentIds: readonly DraftAttachmentId[] = []
  private disposed = false
  /** Draft persistence mirror (Conversation store write; receives the clipboard projection). */
  private mirrorFn: ((text: string) => void) | undefined
  /** Live lexicon subscription disposer; undefined until the controller resolves. */
  private lexiconOff: (() => void) | undefined
  /** Default sends retained until admission settles or scope disposal releases their attachments. */
  private readonly detachedDrafts = new Map<number, DetachedDraft>()
  /** Failed default sends waiting to be restored together in submission order. */
  private readonly failedDetached = new Map<number, DetachedDraft>()
  /** Revision of the last automatic failure restoration. */
  private failedRestoreRev: number | undefined
  private restoringFailures = false
  private attachmentFlightSeq = 0
  /** Attachment-only sends retained until admission settles or scope disposal releases their attachments. */
  private readonly attachmentFlights = new Map<number, {
    readonly controller: AbortController
    readonly attachmentIds: readonly DraftAttachmentId[]
  }>()
  /**
   * Reference-derived attachment ids per in-flight attempt.
   *
   * The draft record cannot carry them alone: a scope disposed while a
   * resolution is in flight drops the record without ever reading it, and
   * those registered bytes would outlive every owner. Disposal drains this
   * map, so an aborted attempt never leaks its files.
   */
  private readonly derivedFlights = new Map<number, readonly DraftAttachmentId[]>()

  constructor(private readonly deps: SessionInputDeps) {
    this.editor = createEditor({
      namespace: 'dsh-composer',
      nodes: [ReferenceChipNode, TextRefNode],
      onError: (error) => { throw error },
    })
    this.unregister = mergeRegister(
      registerPlainText(this.editor),
      registerHistory(this.editor, createEmptyHistoryState(), HISTORY_MERGE_DELAY_MS),
      this.editor.registerUpdateListener(() => { this.onEditorUpdate() }),
      registerClaimDecoration(this.editor, () => this.activeClaimToken()),
      registerTextRefDecoration(this.editor, () => this.lexicon.getSnapshot(), () => this.activeClaimToken()),
      () => { this.lexiconOff?.() },
    )
    this.state = createSnapshotStore<InputState>(this.compose())
    deps.queue?.subscribe(() => { this.publish() })
  }

  // ---- editor plumbing ----

  /**
   * Run one editor edit whose result is observable on return. At the top
   * level this is a discrete update. Inside this editor's own update —
   * command handlers land here synchronously (space/enter picks, paste) —
   * $-functions are already legal, and wrapping them in update() would DEFER
   * them past the synchronous bail answer (and a nested discrete throws);
   * the body runs directly and the outer update commits it.
   * @param fn - the $-edit body.
   */
  private applyEdit(fn: () => void, tag?: string): void {
    if (this.editor._updating) {
      // Nested application joins the enclosing update (the PASTE_COMMAND
      // dispatch path always lands here), so the tag attaches to that update.
      if (tag !== undefined) $addUpdateTag(tag)
      fn()
      return
    }
    this.editor.update(fn, { discrete: true, ...(tag === undefined ? {} : { tag }) })
  }


  /**
   * Subscribe the text-ref re-scan to the controller's lexicon once the
   * controller resolves. The deps thunk cannot resolve at construction (the
   * shell is created inside the sessions provide materialization), so the
   * first interactive updates retry until it can.
   */
  private ensureLexiconSubscription(): void {
    if (this.lexiconOff !== undefined) return
    const controller = this.deps.inputTriggers?.()
    if (controller === undefined) return
    this.lexiconOff = controller.lexicon.subscribe(() => { rescanTextRefs(this.editor) })
  }

  /** Re-project, run the claim watch, publish, and feed trigger tracking after every editor commit. */
  private onEditorUpdate(): void {
    this.ensureLexiconSubscription()
    const prev = this.projection
    this.projection = this.editor.getEditorState().read(() =>
      $projectComposer(key => this.occurrenceIdOf(key)))
    // Selection-only commits advance neither the revision nor the published
    // state: menus still track the caret below, while draftRev moves only
    // with content so a snapshot-built span (apply.ts) stays CAS-valid across
    // caret motion and subscribers do not re-render per caret move.
    if (projectionContentChanged(prev, this.projection)) {
      this.rev += 1
      if (!this.restoringFailures && this.failedRestoreRev !== undefined) {
        this.failedDetached.clear()
        this.failedRestoreRev = undefined
      }
      this.dispatchRun(({ type: 'draft-changed', draft: this.projection.clipboardText }))
    }
    const caret = this.projection.caret
    if (caret !== null) {
      this.deps.inputTriggers?.()?.track(
        this.projection.detectText, caret, { tier: guardOf(this.core.state.phase) }, this.rev,
      )
    }
  }

  private occurrenceIdOf(key: NodeKey): number {
    const existing = this.occurrenceIds.get(key)
    if (existing !== undefined) return existing
    this.occurrenceSeq += 1
    this.occurrenceIds.set(key, this.occurrenceSeq)
    return this.occurrenceSeq
  }

  // ---- SessionInput face ----

  /**
   * Replace the whole draft (persisted-draft seed and programmatic writes).
   * Placeholder-sanitized; newlines split paragraphs; the caret lands at the
   * end. Merged into history so a seed is not an undoable step of its own.
   * @param text - the full next draft.
   */
  setDraft(text: string): void {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, '')
    if (clean === this.projection.clipboardText) return
    this.editor.update(() => {
      const root = $getRoot()
      root.clear()
      for (const line of clean.split('\n')) {
        const paragraph = $createParagraphNode()
        if (line !== '') paragraph.append($createTextNode(line))
        root.append(paragraph)
      }
      root.selectEnd()
    }, { discrete: true, tag: HISTORY_MERGE_TAG })
  }

  /** Append ordered attachment ids unless an admission transaction is locked. */
  addAttachments(ids: readonly DraftAttachmentId[]): boolean {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return false
    if (ids.length === 0) return true
    this.attachmentIds = [...this.attachmentIds, ...ids]
    this.publish()
    return true
  }

  /**
   * Remove one attachment id from this draft. Busy admission phases refuse, like
   * {@link addAttachments}: a removal landing while a command submit serializes
   * would otherwise vanish from the rail yet still ride the in-flight send.
   */
  removeAttachment(id: DraftAttachmentId): boolean {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return false
    const next = this.attachmentIds.filter(candidate => candidate !== id)
    if (next.length === this.attachmentIds.length) return false
    this.attachmentIds = next
    this.publish()
    return true
  }

  /**
   * Keep only ids that still resolve in the browser attachment registry.
   * @param available - live registry ids.
   */
  pruneAttachments(available: readonly DraftAttachmentId[]): void {
    const keep = new Set(available)
    const next = this.attachmentIds.filter(id => keep.has(id))
    if (next.length === this.attachmentIds.length) return
    this.attachmentIds = next
    this.publish()
  }

  /**
   * Clear the draft as a successful-send commit: the editor empties (no undo
   * unit) and the undo history is cut, so Ctrl/Cmd-Z cannot resurrect sent
   * content (the command path gets the same discipline from submit-settled).
   * @param attachmentIds - admitted attachment ids to remove from this draft.
   */
  commitSend(attachmentIds: readonly DraftAttachmentId[]): void {
    const submitted = new Set(attachmentIds)
    this.attachmentIds = this.attachmentIds.filter(id => !submitted.has(id))
    this.dispatchRun(({ type: 'send-committed' }))
  }

  /**
   * Insert pasted plain text over the current editor selection
   * (placeholder-sanitized). The paste event's own default is suppressed by
   * the caller; PASTE_TAG makes the paste its own history boundary, so one
   * undo never removes both the paste and typing inside the merge window.
   * @param text - pasted plain text.
   */
  paste(text: string): void {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, '')
    if (clean === '') return
    this.applyEdit(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) {
        selection.insertText(clean)
        return
      }
      // No selection yet (never-focused surface): land at the document end,
      // growing the first paragraph when the tree is empty.
      const root = $getRoot()
      if (root.getChildrenSize() === 0) root.append($createParagraphNode())
      root.selectEnd().insertText(clean)
    }, PASTE_TAG)
  }

  /**
   * Enter adjudication + submit transaction + default sink. Effects fan out
   * from the machine; this method only feeds the event. Lock entry
   * (adjudicating/submitting) force-closes the transient layers: the popup
   * dismisses and the menu tracks frozen.
   */
  submit(mode: InputSubmitMode = 'queue'): void {
    if (this.snapshot.draft.trim() === '' && this.attachmentIds.length > 0) {
      if (this.snapshot.phase === 'plain') {
        const attachmentIds = [...this.attachmentIds]
        const controller = new AbortController()
        this.attachmentFlightSeq += 1
        const flight = this.attachmentFlightSeq
        this.attachmentFlights.set(flight, { controller, attachmentIds })
        this.commitSend(attachmentIds)
        void this.deps.defaultSink('', attachmentIds, mode, controller.signal).then((outcome) => {
          if (this.disposed || !this.attachmentFlights.delete(flight)) return
          if (outcome.kind === 'success') return
          this.restoreAttachments(attachmentIds)
          if (outcome.text !== undefined) this.notify('error', outcome.text)
        }, (error: unknown) => {
          if (this.disposed || !this.attachmentFlights.delete(flight)) return
          this.restoreAttachments(attachmentIds)
          this.notify('error', error instanceof Error ? error.message : String(error))
        })
      }
      return
    }
    // Claimed pre-gate: a claim that does not declare attachment acceptance never
    // submits while attachments are present — one notice, everything retained.
    // Enter-time adjudication applies the same policy for unclaimed lines
    // inside the command source itself.
    const before = this.snapshot
    // A claimed command that refuses attachments never submits while the draft
    // carries bytes — whether they sit on the rail or come from a canvas
    // reference. Sending text alone would tell the model an image arrived when
    // it did not, so this refuses outright instead of downgrading.
    if (before.phase === 'claimed' && before.claim?.attachments !== true
      && (this.attachmentIds.length > 0 || this.hasAttachmentContributingReference())) {
      this.notify('error', this.deps.commandAttachments.unsupportedNotice(before.claim?.token ?? before.draft))
      return
    }
    this.dispatchRun(({ type: 'enter', mode, draft: this.projection.clipboardText }))
    const phase = this.snapshot.phase
    if (phase === 'adjudicating' || phase === 'submitting') {
      this.deps.popup?.()?.dismiss()
      this.deps.inputTriggers?.()?.track(this.projection.detectText, 0, { tier: 'frozen' }, this.rev)
    }
  }

  /**
   * Keyboard arbitration while the menu is open.
   * @param key - the intercepted key.
   * @param composing - IME composition guard state.
   * @returns the menu's verdict; 'pass' when no pipeline is mounted.
   */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome {
    return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? 'pass'
  }

  /**
   * Steer every still-pending queued message into the running turn (the
   * empty-draft accelerated-Enter gesture). Execution belongs to the hub's
   * queue choreography; absent dep = the gesture falls back to the machine's
   * empty-draft no-op.
   */
  steerQueue(): void {
    this.deps.steerQueue?.()
  }

  /**
   * Space adjudication over the controller's hot state.
   * @returns true = a claim/insert was applied — the caller preventDefaults.
   */
  space(): boolean {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) return false
    return inputTriggers.onSpace()
    // No re-track here: applying the claim/insert mutates the editor, and the
    // update listener re-tracks at the settled caret on its own.
  }

  /** Dismiss the popupSelect shell (any interaction outside the box). */
  dismissPopup(): void {
    this.deps.popup?.()?.dismiss()
  }

  /**
   * The live selection as a detect-coordinate span (menu-launcher synthetic
   * hits replace it on pick); an absent selection answers a collapsed span at
   * the document end.
   * @returns the ordered [start, end) span in detect coordinates.
   */
  caretSpan(): { start: number; end: number } {
    if (this.projection.selection !== null) return this.projection.selection
    const at = this.projection.detectText.length
    return { start: at, end: at }
  }

  /**
   * Hot plain-text reference lexicon source for the decoration scan:
   * delegates to the controller's aggregated store. Stable
   * identity per shell; without a pipeline the snapshot is the empty Map and
   * subscribers never fire.
   */
  readonly lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>> = {
    getSnapshot: () => this.deps.inputTriggers?.()?.lexicon.getSnapshot() ?? EMPTY_LEXICON,
    subscribe: fn => this.deps.inputTriggers?.()?.lexicon.subscribe(fn) ?? (() => {}),
  }

  // ---- scoped-event application verbs ----

  /**
   * Apply one command claim (scoped begin-command event listener body): the
   * editor replaces [0, span.end) with the claim token, then the machine
   * enters claimed.
   * @param claim - the command claim from the pick path.
   * @param span - pick-time span snapshot (detect coordinates).
   * @returns whether the edit applied (phase, span CAS, and leading guard passed).
   */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean {
    const phase = this.core.state.phase
    if (phase !== 'plain' && phase !== 'claimed') return false
    if (span.draftRev !== this.rev) return false
    // Leading-trigger contract: only whitespace may precede the span; the
    // whitespace prefix is dropped so the claimed watch (startsWith) holds.
    if (this.projection.detectText.slice(0, span.start).trim() !== '') return false
    let applied = false as boolean
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithText({ start: 0, end: span.end }, claim.token)
    })
    if (!applied) return false
    this.dispatchRun(({ type: 'claim', claim }))
    return true
  }

  /**
   * Apply one reference insertion (scoped insert-reference event listener
   * body): the editor replaces the span with one chip node, followed by a
   * separating space unless one is already next.
   * @param ref - the reference insertion from the pick path.
   * @param span - pick-time span snapshot (detect coordinates).
   * @returns whether the edit applied.
   */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean {
    const phase = this.core.state.phase
    if (phase !== 'plain' && phase !== 'claimed') return false
    if (span.draftRev !== this.rev) return false
    const tail = this.projection.detectText.slice(span.end, span.end + 1)
    let applied = false
    this.applyEdit(() => {
      const nodes = tail === ' '
        ? [$createReferenceChipNode(ref)]
        : [$createReferenceChipNode(ref), $createTextNode(' ')]
      applied = $replaceDetectSpanWithNodes(span, nodes)
    })
    return applied
  }

  /**
   * Consume one command token after business success (scoped consume-token
   * event listener body). Span guard: revision CAS then splice; bare-token
   * guard: trimmed-draft equality then clear.
   * @param guard - exact span or bare-token guard.
   * @returns whether the token was consumed.
   */
  consumeToken(guard: ConsumeTokenRequest['guard']): boolean {
    if (guard.kind === 'span') {
      if (guard.span.draftRev !== this.rev || guard.span.start === guard.span.end) return false
      let applied = false
      this.applyEdit(() => {
        applied = $replaceDetectSpanWithText(guard.span, '')
      })
      return applied
    }
    if (guard.token === '' || this.projection.clipboardText.trim() !== guard.token) return false
    this.setDraft('')
    return true
  }

  /**
   * Insert plain reference text over the pick-time span (scoped insert-text
   * event listener body; the plain-text reference path). The editor gains
   * ordinary characters — no chip node; the chip look is a scan-derived
   * decoration, never state.
   * @param text - the plain reference text to splice in (e.g. `/name `).
   * @param span - pick-time span snapshot (detect coordinates).
   * @param keepCompleting - contract passenger; completion re-opening is
   * automatic here (the update listener re-tracks at the settled caret, so an
   * open token — a directory pick's trailing slash — reopens the menu without
   * an explicit re-track).
   * @returns whether the text was applied.
   */
  insertText(text: string, span: TokenSpan, keepCompleting = false): boolean {
    void keepCompleting
    if (span.draftRev !== this.rev) return false
    let applied = false
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithText(span, text)
    })
    return applied
  }

  /**
   * Surface a notice from outside the machine (detached command results).
   * @param level - severity tier.
   * @param text - notice body.
   */
  notify(level: 'info' | 'error', text: string): void {
    this.noticeSeq += 1
    this.notices.set({ level, text, seq: this.noticeSeq })
  }

  // ---- wiring-layer extras (not on the frozen SessionInput face) ----

  /**
   * Teardown the shell and return every browser-owned attachment still retained by
   * the draft or an unsettled default send.
   * @returns attachment ids the scope disposer must release.
   */
  dispose(): readonly DraftAttachmentId[] {
    if (this.disposed) return []
    const retained = new Set(this.attachmentIds)
    for (const record of this.detachedDrafts.values()) {
      for (const attachmentId of record.attachmentIds) retained.add(attachmentId)
    }
    // Reference-derived bytes have no rail owner: an attempt that never
    // settles must free them here or they outlive the session scope.
    const derived = [...this.derivedFlights.values()].flat()
    this.deps.releaseAttachments?.(derived)
    for (const flight of this.attachmentFlights.values()) {
      for (const attachmentId of flight.attachmentIds) retained.add(attachmentId)
      flight.controller.abort()
    }
    this.disposed = true
    this.dispatchRun(({ type: 'release' }))
    this.unregister()
    this.editor.setRootElement(null)
    this.detachedDrafts.clear()
    this.failedDetached.clear()
    this.attachmentFlights.clear()
    this.derivedFlights.clear()
    return [...retained]
  }

  /** Read the live input state (guard derivation reads here). */
  get snapshot(): InputState {
    return this.state.getSnapshot()
  }

  /**
   * Bind the draft persistence mirror (Conversation store write). Adopt-on-bind: the
   * store draft may hold a persisted value from a previous mount; the caller
   * seeds it via setDraft BEFORE binding, and afterwards every editor-adopted
   * draft mirrors out.
   * @param write - store draft write.
   * @returns the unbind disposer.
   */
  bindMirror(write: (text: string) => void): () => void {
    this.mirrorFn = write
    return () => {
      if (this.mirrorFn === write) this.mirrorFn = undefined
    }
  }

  // ---- effect executor ----

  /** The claim token the decoration transform styles; null while unclaimed. */
  private activeClaimToken(): string | null {
    const core = this.core.state
    return (core.phase === 'claimed' || core.phase === 'submitting') && core.claim !== undefined
      ? core.claim.token
      : null
  }

  /** Dispatch + execute, refreshing the claim decoration when the styled token flips. */
  private dispatchRun(ev: Parameters<SubmitMachine['dispatch']>[0]): void {
    const beforeToken = this.activeClaimToken()
    this.run(this.core.dispatch(ev))
    if (this.activeClaimToken() !== beforeToken) refreshClaimDecoration(this.editor)
  }

  private run(effects: readonly InputEffect[]): void {
    for (const fx of effects) this.execute(fx)
    this.publish()
  }

  private execute(fx: InputEffect): void {
    switch (fx.type) {
      case 'notice': {
        this.noticeSeq += 1
        this.notices.set({ level: fx.level, text: fx.text, seq: this.noticeSeq })
        return
      }
      case 'adjudicate': {
        this.adjudicate(fx.attempt, fx.draft)
        return
      }
      case 'begin-submit': {
        this.beginSubmit(fx.attempt, fx.claim, fx.args)
        return
      }
      case 'default-sink': {
        this.sinkSerialized(fx.attempt, fx.draft, fx.mode)
        return
      }
      case 'commit-draft': {
        this.commitDraft(fx.retainSuffixOf)
        return
      }
    }
  }

  /**
   * Execute the commit-draft effect: clear the committed content (retaining
   * a pure typed-during-flight suffix when the snapshot allows) and cut the
   * undo history so sent content cannot resurrect.
   */
  private commitDraft(retainSuffixOf: string | null): void {
    this.editor.update(() => {
      const layout = $composerLayout()
      const clip = layout.clipboardText
      if (retainSuffixOf !== null && clip !== retainSuffixOf && clip.startsWith(retainSuffixOf)) {
        $replaceDetectSpanWithText(
          { start: 0, end: detectOffsetOfClipboardOffset(layout, retainSuffixOf.length) }, '',
        )
        return
      }
      const root = $getRoot()
      root.clear()
      root.selectEnd()
    }, { discrete: true, tag: HISTORY_MERGE_TAG })
    this.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
  }

  /**
   * Prompt serialization before the sink: expand each chip occurrence to its
   * owner's model form via the session controller's codec routing. Owner
   * missing or serialization failure rejects the detached send and restores
   * its editor snapshot. Chip-free drafts skip the async detour.
   */
  private sinkSerialized(
    attempt: SubmitAttempt,
    draft: string,
    mode: InputSubmitMode,
  ): void {
    const attachmentIds = [...this.attachmentIds]
    this.attachmentIds = []
    const occurrences = this.projection.occurrences
    const record: DetachedDraft = { draft, occurrences, attachmentIds, derivedAttachmentIds: [] }
    this.detachedDrafts.set(attempt.seq, record)
    if (this.failedRestoreRev === this.rev) {
      this.failedDetached.clear()
      this.failedRestoreRev = undefined
    }
    const inputTriggers = this.deps.inputTriggers?.()
    const contributesAttachments = (source: string): boolean =>
      inputTriggers?.referenceContributesAttachments(source) ?? false
    // 持久化回灌的草稿只剩字面 wire 文本；它同样携带附件语义，必须与 chip 一起
    // 解析，否则重开对话后的引用会静默丢掉图片。
    const persisted = scanPersistedReferences(draft, occurrences, contributesAttachments)
    if (occurrences.length === 0 && persisted.length === 0) {
      this.settleSink(attempt, this.deps.defaultSink(draft.trim(), attachmentIds, mode, attempt.signal))
      return
    }
    const resolutions = [
      ...occurrences.map(o => ({ source: o.source, ref: o.ref, offset: o.offset, length: o.length })),
      ...persisted.map(p => ({ source: p.source, ref: p.ref, offset: p.offset, length: p.length })),
    ].sort((left, right) => left.offset - right.offset)
    void Promise.all(resolutions.map(async (o) => {
      if (inputTriggers === undefined) throw new Error(`no serializer for reference source "${o.source}"`)
      // Reference bytes resolve in the same attempt as the reference text: a
      // source that promised model-visible files either delivers them with
      // this send or fails it, never silently dropping to a URL-only prompt.
      const files = await inputTriggers.referenceAttachments(o.source, o.ref, attempt.signal)
      return {
        offset: o.offset,
        length: o.length,
        text: await inputTriggers.serializeReference(o.source, o.ref, attempt.signal),
        files,
      }
    })).then(
      (parts) => {
        if (this.disposed) return
        // Splice model forms over their clipboard ranges (offsets are
        // clipboard-projection; parts arrive offset-sorted since chips walk in
        // document order).
        let out = ''
        let cursor = 0
        for (const part of parts) {
          out += draft.slice(cursor, part.offset) + part.text
          cursor = part.offset + part.length
        }
        out += draft.slice(cursor)
        const derived = this.deriveAttachmentIds(parts.flatMap(part => [...part.files]))
        if (derived === null) {
          this.settleDetachedFailure(attempt, 'reference attachments unavailable')
          return
        }
        record.derivedAttachmentIds.push(...derived)
        this.derivedFlights.set(attempt.seq, derived)
        this.settleSink(attempt, this.deps.defaultSink(out.trim(), [...attachmentIds, ...derived], mode, attempt.signal))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.settleDetachedFailure(attempt, message)
      },
    )
  }

  /**
   * Register reference-derived files, or answer null when the composition
   * cannot carry them.
   *
   * A reference source only contributes files when the conversation layer
   * mounted the derivation seam; a source that produced files against a missing
   * seam is a wiring defect, and sending the text alone would tell the user an
   * image was attached while the model never saw it.
   * @param files - files contributed by every occurrence of this attempt.
   * @returns the registered draft ids, or null when the seam is absent.
   */
  private deriveAttachmentIds(files: readonly File[]): readonly DraftAttachmentId[] | null {
    if (files.length === 0) return []
    const deps = this.deps
    if (deps.deriveAttachments === undefined) return null
    return deps.deriveAttachments(files)
  }

  /**
   * Whether any chip in the current draft belongs to a source that carries
   * model-visible bytes.
   *
   * The claimed-command path cannot transport them when the claim refuses
   * attachments, and `codec.serialize` still renders the reference as an
   * attached asset. Refusing the send is the only honest outcome: sending the
   * text alone would tell the model a picture arrived when it did not.
   * @returns true when at least one occurrence contributes attachments.
   */
  private hasAttachmentContributingReference(): boolean {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) return false
    const occurrences = this.projection.occurrences
    if (occurrences.some(occurrence => inputTriggers.referenceContributesAttachments(occurrence.source))) {
      return true
    }
    // A draft restored from persistence carries the same references as literal
    // text; they contribute bytes just like chips do.
    return scanPersistedReferences(
      this.projection.clipboardText,
      occurrences,
      source => inputTriggers.referenceContributesAttachments(source),
    )
      .some(reference => inputTriggers.referenceContributesAttachments(reference.source))
  }

  /** Settle one detached default send independently of other sends. */
  private settleSink(
    attempt: SubmitAttempt,
    pending: Promise<SubmitOutcome>,
  ): void {
    pending.then(
      (outcome) => {
        if (this.dead(attempt)) return
        if (outcome.kind !== 'success') {
          this.settleDetachedFailure(attempt, outcome.text)
          return
        }
        this.derivedFlights.delete(attempt.seq)
        this.detachedDrafts.delete(attempt.seq)
        this.dispatchRun(({ type: 'sink-settled', attempt, ok: true, outcome }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        this.settleDetachedFailure(attempt, error instanceof Error ? error.message : String(error))
      },
    )
  }

  /** Restore one failed detached send without overwriting text entered after a restoration. */
  private settleDetachedFailure(attempt: SubmitAttempt, message?: string): void {
    const record = this.detachedDrafts.get(attempt.seq)
    if (record === undefined) return
    this.detachedDrafts.delete(attempt.seq)
    // Reference-derived attachments belong to this attempt alone; the chip
    // that produced them stays in the draft and re-resolves on retry, so
    // dropping the bytes here cannot lose user content.
    this.derivedFlights.delete(attempt.seq)
    this.deps.releaseAttachments?.(record.derivedAttachmentIds)
    this.restoreAttachments(record.attachmentIds)
    this.failedDetached.set(attempt.seq, record)
    if (this.projection.clipboardText === '' || this.failedRestoreRev === this.rev) {
      this.restoreFailedDrafts()
    }
    this.dispatchRun(({ type: 'sink-settled', attempt, ok: false, ...(message === undefined ? {} : { message }) }))
  }

  /** Rebuild all currently failed snapshots in submission order. */
  private restoreFailedDrafts(): void {
    const records = [...this.failedDetached.entries()].sort(([a], [b]) => a - b).map(([, record]) => record)
    if (records.length === 0) return
    const separator = '\n\n'
    let draft = ''
    const occurrences: Occurrence[] = []
    for (const record of records) {
      const base = draft.length + (draft === '' ? 0 : separator.length)
      if (draft !== '') draft += separator
      draft += record.draft
      for (const occurrence of record.occurrences) {
        occurrences.push({ ...occurrence, offset: base + occurrence.offset })
      }
    }
    this.restoringFailures = true
    try {
      this.editor.update(() => {
        const root = $getRoot()
        root.clear()
        let paragraph = $createParagraphNode()
        root.append(paragraph)
        const appendText = (text: string): void => {
          const lines = text.split('\n')
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i]
            if (line !== '') paragraph.append($createTextNode(line))
            if (i < lines.length - 1) {
              paragraph = $createParagraphNode()
              root.append(paragraph)
            }
          }
        }
        let cursor = 0
        for (const occurrence of occurrences) {
          appendText(draft.slice(cursor, occurrence.offset))
          paragraph.append(new ReferenceChipNode({
            source: occurrence.source,
            ref: occurrence.ref,
            label: occurrence.label,
            ...(occurrence.appearance === undefined ? {} : { appearance: occurrence.appearance }),
            // Restored failures keep whatever preview the original chip showed;
            // a reference that never carried one stays glyph-only.
            ...(occurrence.thumbnailUrl === undefined ? {} : { thumbnailUrl: occurrence.thumbnailUrl }),
            clipboardText: occurrence.clipboardText,
          }, occurrence.invalid === true))
          cursor = occurrence.offset + occurrence.length
        }
        appendText(draft.slice(cursor))
        root.selectEnd()
      }, { discrete: true, tag: HISTORY_MERGE_TAG })
      this.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
      this.failedRestoreRev = this.rev
    } finally {
      this.restoringFailures = false
    }
  }

  /** Return failed-send attachments to the head of the rail; release happens only after success. */
  private restoreAttachments(attachmentIds: readonly DraftAttachmentId[]): void {
    if (attachmentIds.length === 0) return
    const current = new Set(this.attachmentIds)
    const restored = attachmentIds.filter(id => !current.has(id))
    if (restored.length === 0) return
    this.attachmentIds = [...restored, ...this.attachmentIds]
    this.publish()
  }

  /** Enter adjudication: poll the session controller; failure = notice + draft retained (never a silent downgrade). */
  private adjudicate(attempt: SubmitAttempt, draft: string): void {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) {
      // No pipeline mounted: the '/' line is an ordinary message.
      this.dispatchRun(({ type: 'adjudicated', attempt, outcome: undefined }))
      return
    }
    inputTriggers.adjudicate(draft.trim(), attempt.signal, { attachments: this.attachmentIds.length }).then(
      (outcome: PickOutcome) => {
        if (this.dead(attempt)) return
        this.dispatchRun(({ type: 'adjudicated', attempt, outcome }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.dispatchRun(({ type: 'adjudication-failed', attempt, message }))
      },
    )
  }

  /**
   * The submit transaction: claim.submit against the session scope; ok maps
   * from the outcome kind. An accepting claim receives the serialized draft
   * attachments, which are cleared and released only on a success outcome; a
   * failure (serialize, transport, or handler error) keeps draft and attachments
   * for correction.
   */
  private beginSubmit(attempt: SubmitAttempt, claim: CommandClaim, args: string): void {
    const attachmentIds = claim.attachments === true ? [...this.attachmentIds] : []
    Promise.resolve()
      .then(async () => {
        const attachments = attachmentIds.length > 0 ? await this.deps.commandAttachments.serialize(attachmentIds) : []
        // Serialization may outlive the attempt (large files, session
        // teardown); a dead attempt must not reach the Host executor.
        if (this.dead(attempt)) return undefined
        return claim.submit(args, this.deps.actx, attachments)
      })
      .then(
        (outcome) => {
          if (outcome === undefined || this.dead(attempt)) return
          if (outcome.kind === 'success' && attachmentIds.length > 0) {
            const submitted = new Set(attachmentIds)
            this.attachmentIds = this.attachmentIds.filter(id => !submitted.has(id))
            this.deps.commandAttachments.release(attachmentIds)
          }
          this.dispatchRun(({
            type: 'submit-settled', attempt, ok: outcome.kind === 'success',
            draft: this.projection.clipboardText, outcome,
            ...(outcome.kind === 'error' && outcome.text === undefined ? { message: 'command failed' } : {}),
          }))
        },
        (error: unknown) => {
          if (this.dead(attempt)) return
          const message = error instanceof Error ? error.message : String(error)
          this.dispatchRun(({
            type: 'submit-settled', attempt, ok: false,
            draft: this.projection.clipboardText, message,
          }))
        },
      )
  }

  /** Late-settlement guard: superseded attempts and disposed facades drop silently. */
  private dead(attempt: SubmitAttempt): boolean {
    return this.disposed || attempt.signal.aborted
  }

  private compose(): InputState {
    const core = this.core.state
    return {
      draft: this.projection.clipboardText,
      attachmentIds: this.attachmentIds,
      draftRev: this.rev,
      phase: core.phase,
      ...(core.claim !== undefined ? { claim: core.claim } : {}),
      occurrences: this.projection.occurrences,
      queue: this.deps.queue?.getSnapshot() ?? EMPTY_QUEUE,
    }
  }

  private publish(): void {
    const next = this.compose()
    this.state.set(next)
    if (next.draft !== this.lastMirroredDraft) {
      this.lastMirroredDraft = next.draft
      this.mirrorFn?.(next.draft)
    }
  }
}
