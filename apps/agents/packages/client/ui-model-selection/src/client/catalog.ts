/** One Host-generation model catalog shared by every Session selector. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Observable lifecycle of the shared model catalog. */
export interface ModelCatalogState {
  value: ModelCatalog | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

/** Loads at most one model catalog for the current Host generation. */
export class ModelCatalogDirectory {
  /** Current shared catalog value and load lifecycle. */
  readonly store: SnapshotStore<ModelCatalogState> = createSnapshotStore({
    value: null,
    status: 'idle',
    error: null,
  })

  private generation = 0
  private inflight: Promise<ModelCatalog> | undefined
  private hostCatalog: ModelCatalog | null = null
  private externalCatalog: Pick<ModelCatalog, 'groups' | 'failures'> | null = null

  /**
   * @param ctx - the providing plugin's context, whose `remote.session`
   * namespace carries the Host-generation catalog.
   */
  constructor(private readonly ctx: ClientContext) {
    if (typeof window !== 'undefined') {
      const onMessage = (event: MessageEvent<unknown>): void => {
        if (event.source !== window.parent || event.origin !== window.location.origin) return
        const catalog = parseExternalCatalogMessage(event.data)
        if (catalog !== null) this.setExternalCatalog(catalog)
      }
      window.addEventListener('message', onMessage)
    }
  }

  /** Merge an externally managed catalog into the next shared selector snapshot. */
  setExternalCatalog(catalog: Pick<ModelCatalog, 'groups' | 'failures'> | null): void {
    this.externalCatalog = catalog
    if (this.hostCatalog !== null) this.store.set({
      value: mergeCatalog(this.hostCatalog, this.externalCatalog),
      status: this.store.getSnapshot().status,
      error: this.store.getSnapshot().error,
    })
  }

  /**
   * Return the current generation's catalog, sharing its one in-flight load.
   * @returns the loaded global catalog.
   */
  load(): Promise<ModelCatalog> {
    const state = this.store.getSnapshot()
    if (state.status === 'ready' && state.value !== null) return Promise.resolve(state.value)
    if (this.inflight !== undefined) return this.inflight
    const generation = this.generation
    this.store.update((draft) => {
      draft.status = 'loading'
      draft.error = null
    })
    const operation = this.ctx.remote.session.modelCatalog().then((response) => {
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      if (generation === this.generation) {
        this.hostCatalog = response.value
        this.store.set({ value: mergeCatalog(this.hostCatalog, this.externalCatalog), status: 'ready', error: null })
      }
      return response.value
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.store.update((draft) => {
          draft.status = 'error'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }).finally(() => {
      if (generation === this.generation && this.inflight === operation) this.inflight = undefined
    })
    this.inflight = operation
    return operation
  }

  /**
   * Invalidate the loaded catalog; the next explicit menu read reloads it.
   * @param clear - whether values from the previous Host generation must be hidden.
   */
  private invalidate(clear = false): void {
    this.generation += 1
    this.inflight = undefined
    const value = clear ? null : this.store.getSnapshot().value
    if (clear) this.hostCatalog = null
    this.store.set({ value, status: 'idle', error: null })
  }

  /** Invalidate and reload the catalog after a Host-side model input changes. */
  refresh(): void {
    this.invalidate()
    void this.load().catch(() => { /* the selector exposes the shared error */ })
  }

  /** Clear Host-specific values and load the replacement Host generation. */
  resetGeneration(): void {
    this.invalidate(true)
    void this.load().catch(() => { /* the selector exposes the shared error */ })
  }
}

function mergeCatalog(
  base: ModelCatalog,
  external: Pick<ModelCatalog, 'groups' | 'failures'> | null,
): ModelCatalog {
  if (external === null) return base
  const groups = [...base.groups]
  for (const externalGroup of external.groups) {
    const existing = groups.find((group) => group.id === externalGroup.id)
    if (existing === undefined) {
      groups.push(externalGroup)
      continue
    }
    const models = [...existing.models]
    for (const model of externalGroup.models) {
      if (!models.some((candidate) => candidate.id === model.id)) models.push(model)
    }
    const index = groups.indexOf(existing)
    groups[index] = { ...existing, models }
  }
  return {
    ...base,
    groups,
    failures: [...base.failures, ...external.failures],
  }
}

function parseExternalCatalogMessage(value: unknown): Pick<ModelCatalog, 'groups' | 'failures'> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const message = value as { type?: unknown; catalog?: unknown }
  if (message.type !== 'tapcanvas:model-catalog' || typeof message.catalog !== 'object' || message.catalog === null) return null
  const catalog = message.catalog as { groups?: unknown; failures?: unknown }
  if (!Array.isArray(catalog.groups)) return null
  const groups = catalog.groups.flatMap((groupValue): ModelCatalog['groups'][number][] => {
    if (typeof groupValue !== 'object' || groupValue === null || Array.isArray(groupValue)) return []
    const group = groupValue as { id?: unknown; name?: unknown; models?: unknown }
    if (typeof group.id !== 'string' || typeof group.name !== 'string' || !Array.isArray(group.models)) return []
    const models = group.models.flatMap((modelValue): ModelCatalog['groups'][number]['models'][number][] => {
      if (typeof modelValue !== 'object' || modelValue === null || Array.isArray(modelValue)) return []
      const model = modelValue as { id?: unknown; name?: unknown; description?: unknown }
      if (typeof model.id !== 'string' || typeof model.name !== 'string') return []
      return [{
        id: model.id,
        name: model.name,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
      }]
    })
    return models.length > 0 ? [{ id: group.id, name: group.name, models }] : []
  })
  const failures = Array.isArray(catalog.failures)
    ? catalog.failures.flatMap((failureValue): ModelCatalog['failures'][number][] => {
      if (typeof failureValue !== 'object' || failureValue === null || Array.isArray(failureValue)) return []
      const failure = failureValue as { id?: unknown; name?: unknown; message?: unknown }
      return typeof failure.id === 'string' && typeof failure.name === 'string' && typeof failure.message === 'string'
        ? [{ id: failure.id, name: failure.name, message: failure.message }]
        : []
    })
    : []
  return { groups, failures }
}
