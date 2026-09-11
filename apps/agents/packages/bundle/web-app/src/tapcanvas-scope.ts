import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { defineTool, type ParameterSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'

export interface TapCanvasScope {
  readonly userId?: string | null
  readonly projectId: string | null
  readonly projectName: string | null
  readonly flowId: string | null
  readonly chapterId: string | null
  readonly chapterTitle: string | null
  readonly bookId: string | null
  readonly selectedNodeIds: readonly string[]
  readonly canvas: TapCanvasCanvasSnapshot | null
}

export interface TapCanvasCanvasSnapshot {
  readonly nodes: readonly TapCanvasNodeSnapshot[]
  readonly edges: readonly TapCanvasEdgeSnapshot[]
}

export interface TapCanvasNodeSnapshot {
  readonly id: string
  readonly type: string | null
  readonly position: { readonly x: number; readonly y: number }
  readonly data: Record<string, unknown>
}

export interface TapCanvasEdgeSnapshot {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sourceHandle: string | null
  readonly targetHandle: string | null
}

interface ScopeRecord {
  readonly sessionId: string | undefined
  readonly scope: TapCanvasScope
}

interface WorkspaceLike {
  readonly id: string
}

interface WorkspaceRegistryLike {
  create(path: string, title?: string): Promise<WorkspaceLike>
}

export interface TapCanvasScopeBinding {
  readonly workspaceKey: string
  readonly workspacePath: string
  readonly workspaceId: string
}

const scopes = new Map<string, TapCanvasScope>()
const bindings = new Map<string, TapCanvasScopeBinding>()
const scopesByWorkspacePath = new Map<string, TapCanvasScope>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseScope(value: unknown): ScopeRecord | null {
  if (!isRecord(value) || !isRecord(value.args)) return null
  const sessionId = typeof value.args.sessionId === 'string' ? value.args.sessionId.trim() : undefined
  const rawScope = value.args.scope
  if (!isRecord(rawScope)) return null
  const projectId = typeof rawScope.projectId === 'string' ? rawScope.projectId.trim() : ''
  if (!projectId) return null
  return {
    sessionId,
    scope: rawScope as unknown as TapCanvasScope,
  }
}

/** Derive the stable storage identity for one TapCanvas scope. */
export function tapCanvasWorkspaceKey(scope: TapCanvasScope): string {
  const identity = [scope.projectId, scope.flowId, scope.chapterId, scope.bookId]
    .map(value => value ?? '')
    .join('\u0000')
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32)
}

async function ensureWorkspace(ctx: Context, scope: TapCanvasScope): Promise<TapCanvasScopeBinding> {
  const existing = bindings.get(tapCanvasWorkspaceKey(scope))
  if (existing !== undefined) return existing
  const dshHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (dshHome === '') throw new Error('TapCanvas 画布会话无法绑定：DSH_HOME 未配置')
  const key = tapCanvasWorkspaceKey(scope)
  const workspacePath = join(dshHome, 'tapcanvas-workspaces', key)
  await mkdir(workspacePath, { recursive: true })
  const registry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryLike | undefined
  if (registry === undefined) throw new Error('TapCanvas 画布会话无法绑定：Workspace Registry 未加载')
  const workspace = await registry.create(workspacePath, scope.projectName ?? undefined)
  const binding = { workspaceKey: key, workspacePath, workspaceId: String(workspace.id) }
  bindings.set(key, binding)
  return binding
}

function scopeForAgent(agent: unknown): TapCanvasScope | null {
  if (!isRecord(agent) || typeof agent.id !== 'string') return null
  const direct = scopes.get(agent.id)
  if (direct !== undefined) return direct
  const session = isRecord(agent.session) ? agent.session : null
  const header = session !== null && isRecord(session.header) ? session.header : null
  const cwd = header === null || typeof header.cwd !== 'string' ? '' : header.cwd.trim()
  return cwd === '' ? null : scopesByWorkspacePath.get(cwd) ?? null
}

function success(value: unknown): ConnectionRpcResult<unknown> { return { ok: true, value } }
function failure(code: string, message: string, details: object = {}): ConnectionRpcResult<unknown> {
  return { ok: false, error: { code, message, details } }
}

interface FilmImageGenArguments {
  prompt: string
  vendor: 'comfyui' | 'newapi'
  title?: string
  tag?: string
  aspect_ratio?: string
  ai_model?: string
  prompt_template?: string
  mode_type?: 'text2image' | 'image2image'
  reference_nodes?: readonly string[]
  reference_assets?: readonly string[]
  quality_spec?: string
  model_confirmation?: string
}

interface FilmVideoGenArguments {
  prompt: string
  title: string
  tag?: string
  duration_sec?: number
  aspect_ratio?: string
  resolution?: string
  ai_model?: string
  start_frame_image_node?: string
  end_frame_image_node?: string
  reference_nodes?: readonly string[]
  reference_assets?: readonly string[]
  continuation_from_node?: string
  continuation_mode?: 'first_frame' | 'reference'
  sound?: 'on' | 'off'
  need_bgm?: boolean
  video_subtype?: 'ai_transition'
}

interface FilmVideoCompositeArguments {
  video_list?: readonly { src: string; start_position?: number; end_position?: number }[]
  audio_list?: readonly { src: string; start_time?: number; end_time?: number }[]
  reference_nodes: readonly string[]
  video_volume?: number
  audio_volume?: number
  aspect_ratio?: string
  resolution?: string
  fit?: 'contain' | 'cover'
  format?: string
  title?: string
  tag?: string
  reuse_clip_node_key?: string
}

interface UserQuestionsLike {
  ask(request: { questions: readonly {
    id: string
    question: string
    options?: readonly { label: string; description?: string }[]
    multiSelect?: boolean
    header?: string
  }[]; agent?: unknown; signal?: AbortSignal }): Promise<unknown>
}

interface FilmTaskRecord {
  id: string
  subject: string
  status: 'planned' | 'in_progress' | 'completed'
  task_content: string
  updated_at: string
}

/** 附件影视 Function 的稳定注册名，供运行时和契约测试共享。 */
export const FILM_FUNCTION_NAMES = [
  'film_image_gen', 'film_video_gen', 'film_video_composite', 'film_scene_director',
  'film_video_edit', 'film_ask_human', 'film_memory_recall', 'film_file_write',
  'film_file_read', 'film_task_create', 'film_task_update', 'film_task_list', 'film_task_read',
  'film_audio_gen', 'film_sfx_gen', 'film_asset_save', 'film_asset_search', 'film_color_grade',
] as const

function encodeInternalPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** 与 Hono internal-api-key.ts 保持同一 v2 合同，凭据仅在本次请求头中短暂存在。 */
function buildNativeDelegationKey(internalWorkerToken: string, userId: string): string | null {
  const token = internalWorkerToken.trim()
  const owner = userId.trim()
  if (!token || !owner) return null
  const issuedAt = Date.now()
  const payload = encodeInternalPart(JSON.stringify({
    version: 2,
    userId: owner,
    issuedAt,
    expiresAt: issuedAt + 60 * 60 * 1000,
  }))
  const signature = createHmac('sha256', token).update(payload, 'utf8').digest('base64url')
  return `tc_internal:v2:${payload}:${signature}`
}

export function parseFilmImageGenArguments(value: unknown): FilmImageGenArguments {
  if (!isRecord(value)) throw new Error('film_image_gen 参数必须是对象')
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : ''
  if (!prompt) throw new Error('film_image_gen.prompt 不能为空')
  const mode = value.mode_type
  if (mode !== undefined && mode !== 'text2image' && mode !== 'image2image') {
    throw new Error('film_image_gen.mode_type 只能是 text2image 或 image2image')
  }
  const readList = (candidate: unknown): readonly string[] | undefined => {
    if (candidate === undefined) return undefined
    if (!Array.isArray(candidate)) throw new Error('film_image_gen 参考节点/资产必须是字符串数组')
    const values = candidate.map((item) => {
      if (typeof item !== 'string' || item.trim() === '') throw new Error('film_image_gen 参考节点/资产不能包含空值')
      return item.trim()
    })
    return values.length > 0 ? values : undefined
  }
  const readText = (key: keyof FilmImageGenArguments): string | undefined => {
    const candidate = value[key]
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error(`film_image_gen.${String(key)} 必须是非空字符串`)
    return candidate.trim()
  }
  const vendor = value.vendor
  if (vendor !== 'comfyui' && vendor !== 'newapi') {
    throw new Error('film_image_gen.vendor 必须明确指定为 comfyui 或 newapi')
  }
  const result: FilmImageGenArguments = { prompt, vendor }
  const title = readText('title')
  const tag = readText('tag')
  const aspectRatio = readText('aspect_ratio')
  const aiModel = readText('ai_model')
  const promptTemplate = readText('prompt_template')
  const referenceNodes = readList(value.reference_nodes)
  const referenceAssets = readList(value.reference_assets)
  const qualitySpec = readText('quality_spec')
  const modelConfirmation = readText('model_confirmation')
  if (title) result.title = title
  if (tag) result.tag = tag
  if (aspectRatio) result.aspect_ratio = aspectRatio
  if (aiModel) result.ai_model = aiModel
  if (promptTemplate) result.prompt_template = promptTemplate
  if (mode) result.mode_type = mode
  if (referenceNodes) result.reference_nodes = referenceNodes
  if (referenceAssets) result.reference_assets = referenceAssets
  if (qualitySpec) result.quality_spec = qualitySpec
  if (modelConfirmation) result.model_confirmation = modelConfirmation
  return result
}

function readRequiredText(value: Record<string, unknown>, toolName: string, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error(`${toolName}.${key} 必须是非空字符串`)
  return candidate.trim()
}

function readOptionalText(value: Record<string, unknown>, toolName: string, key: string): string | undefined {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  return readRequiredText(value, toolName, key)
}

function readStringList(value: unknown, toolName: string, key: string, required = false): readonly string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value)) throw new Error(`${toolName}.${key} 必须是字符串数组`)
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') throw new Error(`${toolName}.${key} 不能包含空值`)
    return item.trim()
  })
}

function readFilmVideoArguments(value: unknown): FilmVideoGenArguments {
  if (!isRecord(value)) throw new Error('film_video_gen 参数必须是对象')
  const result: FilmVideoGenArguments = {
    prompt: readRequiredText(value, 'film_video_gen', 'prompt'),
    title: readRequiredText(value, 'film_video_gen', 'title'),
  }
  const textKeys = ['tag', 'aspect_ratio', 'resolution', 'ai_model', 'start_frame_image_node', 'end_frame_image_node', 'continuation_from_node'] as const
  for (const key of textKeys) {
    const text = readOptionalText(value, 'film_video_gen', key)
    if (text !== undefined) result[key] = text
  }
  const references = readStringList(value.reference_nodes, 'film_video_gen', 'reference_nodes')
  if (references.length) result.reference_nodes = references
  const referenceAssets = readStringList(value.reference_assets, 'film_video_gen', 'reference_assets')
  if (referenceAssets.length) result.reference_assets = referenceAssets
  const continuationMode = value.continuation_mode
  if (continuationMode !== undefined && continuationMode !== 'first_frame' && continuationMode !== 'reference') throw new Error('film_video_gen.continuation_mode 只能是 first_frame 或 reference')
  if (continuationMode !== undefined) result.continuation_mode = continuationMode
  if (result.continuation_from_node && result.continuation_mode === undefined) throw new Error('film_video_gen.continuation_from_node 必须同时提供 continuation_mode')
  for (const key of ['duration_sec'] as const) {
    const candidate = value[key]
    if (candidate !== undefined && (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate <= 0)) {
      throw new Error(`film_video_gen.${key} 必须是正整数`)
    }
    if (typeof candidate === 'number') result[key] = candidate
  }
  for (const key of ['sound', 'video_subtype'] as const) {
    const candidate = value[key]
    if (candidate !== undefined && typeof candidate !== 'string') throw new Error(`film_video_gen.${key} 类型错误`)
    if (key === 'sound' && candidate !== undefined && candidate !== 'on' && candidate !== 'off') throw new Error('film_video_gen.sound 只能是 on 或 off')
    if (key === 'video_subtype' && candidate !== undefined && candidate !== 'ai_transition') throw new Error('film_video_gen.video_subtype 只能是 ai_transition')
    if (key === 'sound' && (candidate === 'on' || candidate === 'off')) result.sound = candidate
    if (key === 'video_subtype' && candidate === 'ai_transition') result.video_subtype = candidate
  }
  if (value.need_bgm !== undefined && typeof value.need_bgm !== 'boolean') throw new Error('film_video_gen.need_bgm 必须是布尔值')
  if (typeof value.need_bgm === 'boolean') result.need_bgm = value.need_bgm
  return result
}

function readFilmVideoCompositeArguments(value: unknown): FilmVideoCompositeArguments {
  if (!isRecord(value)) throw new Error('film_video_composite 参数必须是对象')
  const referenceNodes = readStringList(value.reference_nodes, 'film_video_composite', 'reference_nodes', true)
  if (referenceNodes.length === 0) throw new Error('film_video_composite.reference_nodes 不能为空')
  const readClips = (candidate: unknown, key: 'video_list' | 'audio_list') => {
    if (candidate === undefined) return undefined
    if (!Array.isArray(candidate)) throw new Error(`film_video_composite.${key} 必须是数组`)
    return candidate.map((item) => {
      if (!isRecord(item)) throw new Error(`film_video_composite.${key} 项必须是对象`)
      const src = readRequiredText(item, `film_video_composite.${key}`, 'src')
      const result: { src: string; start_position?: number; end_position?: number; start_time?: number; end_time?: number } = { src }
      for (const field of ['start_position', 'end_position', 'start_time', 'end_time'] as const) {
        const candidateNumber = item[field]
        if (candidateNumber !== undefined && typeof candidateNumber !== 'number') throw new Error(`film_video_composite.${key}.${field} 必须是数字`)
        if (typeof candidateNumber === 'number') result[field] = candidateNumber
      }
      return result
    })
  }
  const result: FilmVideoCompositeArguments = { reference_nodes: referenceNodes }
  const videos = readClips(value.video_list, 'video_list')
  const audios = readClips(value.audio_list, 'audio_list')
  if (videos !== undefined) result.video_list = videos.map(({ src, start_position, end_position }) => ({ src, ...(start_position === undefined ? {} : { start_position }), ...(end_position === undefined ? {} : { end_position }) }))
  if (audios !== undefined) result.audio_list = audios.map(({ src, start_time, end_time }) => ({ src, ...(start_time === undefined ? {} : { start_time }), ...(end_time === undefined ? {} : { end_time }) }))
  for (const key of ['video_volume', 'audio_volume'] as const) {
    const numberValue = value[key]
    if (numberValue !== undefined && (typeof numberValue !== 'number' || numberValue < 0 || numberValue > 1)) throw new Error(`film_video_composite.${key} 必须在 0 到 1 之间`)
    if (typeof numberValue === 'number') result[key] = numberValue
  }
  for (const key of ['aspect_ratio', 'resolution', 'format', 'title', 'tag', 'reuse_clip_node_key'] as const) {
    const text = readOptionalText(value, 'film_video_composite', key)
    if (text !== undefined) result[key] = text
  }
  const fit = value.fit
  if (fit !== undefined && fit !== 'contain' && fit !== 'cover') throw new Error('film_video_composite.fit 只能是 contain 或 cover')
  if (fit !== undefined) result.fit = fit
  return result
}

async function executeNativeBridgeTool(
  scope: TapCanvasScope,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  toolCallId?: string,
  vendor?: 'comfyui' | 'newapi',
): Promise<string> {
  const projectId = scope.projectId?.trim() ?? ''
  const flowId = scope.flowId?.trim() ?? ''
  const userId = scope.userId?.trim() ?? ''
  if (!projectId || (!flowId && !scope.chapterId?.trim()) || !userId) {
    throw new Error(`${toolName} 需要当前画布的 userId、projectId，以及 flowId 或 chapterId 作用域`)
  }
  const target = (process.env.TAPCANVAS_API_PROXY_TARGET ?? '').trim()
  if (!target) throw new Error(`${toolName} 无法执行：TAPCANVAS_API_PROXY_TARGET 未配置`)
  const authorization = buildNativeDelegationKey((process.env.INTERNAL_WORKER_TOKEN ?? '').trim(), userId)
  if (!authorization) throw new Error(`${toolName} 无法执行：未配置内部委托密钥`)
  const endpoint = `${target.replace(/\/$/u, '')}/public/agents/tools/execute`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${authorization}` },
    body: JSON.stringify({ toolName, args, ...(toolCallId ? { toolCallId } : {}), ...(vendor ? { vendor } : {}), canvasProjectId: projectId, ...(flowId ? { canvasFlowId: flowId } : {}), ...(scope.chapterId ? { chapterId: scope.chapterId } : {}) }),
    signal,
  })
  const responseBody: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = isRecord(responseBody) && typeof responseBody.message === 'string' ? responseBody.message : `${toolName} 执行失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  if (!isRecord(responseBody) || responseBody.ok !== true) throw new Error(`${toolName} 执行器返回了无效回执`)
  return JSON.stringify(responseBody.data ?? responseBody)
}

function workspaceFilePath(workspacePath: string, requestedPath: string): string {
  const path = requestedPath.trim()
  if (!path || isAbsolute(path) || path.split(/[\\/]/u).includes('..')) throw new Error('影视工具文件路径必须是当前 Agent Workspace 内的相对路径，禁止绝对路径和路径穿越')
  const target = resolve(workspacePath, path)
  const remainder = relative(workspacePath, target)
  if (remainder === '' || remainder.startsWith('..') || isAbsolute(remainder)) throw new Error('影视工具文件路径超出当前 Agent Workspace')
  return target
}

async function executeFilmTaskManager(binding: TapCanvasScopeBinding, args: Record<string, unknown>, operation: 'create' | 'update' | 'list' | 'read'): Promise<string> {
  const file = join(binding.workspacePath, '.film-tasks.json')
  const raw = await readFile(file, 'utf8').catch(() => '[]')
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Error('任务清单文件格式无效')
  const records = parsed as unknown as FilmTaskRecord[]
  if (operation === 'list') return JSON.stringify(records)
  const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : crypto.randomUUID()
  const index = records.findIndex((item) => item.id === id)
  if (operation === 'read') {
    if (index < 0) throw new Error(`任务不存在：${id}`)
    return JSON.stringify(records[index])
  }
  const now = new Date().toISOString()
  if (operation === 'create') {
    if (index >= 0) throw new Error(`任务已存在：${id}`)
    const subject = readRequiredText(args, 'film_task_create', 'subject')
    records.push({ id, subject, status: 'planned', task_content: typeof args.task_content === 'string' ? args.task_content : '', updated_at: now })
  } else {
    if (index < 0) throw new Error(`任务不存在：${id}`)
    const current = records[index]!
    records[index] = {
      ...current,
      ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
      ...(typeof args.task_content === 'string' ? { task_content: args.task_content } : {}),
      ...(args.status === 'planned' || args.status === 'in_progress' || args.status === 'completed' ? { status: args.status } : {}),
      updated_at: now,
    }
  }
  await writeFile(file, JSON.stringify(records, null, 2), 'utf8')
  return JSON.stringify(operation === 'create' ? records[records.length - 1] : records[index])
}

async function executeFilmImageGen(
  scope: TapCanvasScope,
  args: unknown,
  signal: AbortSignal,
  toolCallId?: string,
): Promise<string> {
  const input = parseFilmImageGenArguments(args)
  const projectId = scope.projectId?.trim() ?? ''
  const flowId = scope.flowId?.trim() ?? ''
  const userId = scope.userId?.trim() ?? ''
  if (!projectId || (!flowId && !scope.chapterId?.trim()) || !userId) {
    throw new Error('film_image_gen 需要当前画布的 userId、projectId，以及 flowId 或 chapterId 作用域')
  }
  const nodeId = crypto.randomUUID()
  const x = scope.canvas?.nodes.length ? Math.max(...scope.canvas.nodes.map((node) => node.position.x)) + 420 : 0
  const y = scope.canvas?.nodes.length ? scope.canvas.nodes[scope.canvas.nodes.length - 1]?.position.y ?? 0 : 0
  const nodeData: Record<string, unknown> = {
    kind: input.mode_type === 'image2image' ? 'imageEdit' : 'image',
    label: input.title ?? 'Film Image',
    prompt: input.prompt,
    ...(input.aspect_ratio ? { aspect: input.aspect_ratio } : {}),
    ...(input.ai_model ? { imageModel: input.ai_model } : {}),
    ...(input.reference_nodes ? { referenceImageNodeIds: [...input.reference_nodes] } : {}),
    ...(input.reference_assets ? { referenceAssetIds: [...input.reference_assets] } : {}),
    ...(input.tag ? { tag: input.tag } : {}),
    ...(input.prompt_template ? { promptTemplate: input.prompt_template } : {}),
    ...(input.quality_spec ? { qualitySpec: input.quality_spec } : {}),
    ...(input.model_confirmation ? { modelConfirmation: input.model_confirmation } : {}),
  }
  return executeNativeBridgeTool(scope, 'tapcanvas_image_generate_to_canvas', {
    node: { id: nodeId, type: 'taskNode', position: { x, y }, data: nodeData },
  }, signal, toolCallId, input.vendor)
}

export function registerTapCanvasRuntime(ctx: Context): void {
  ctx.connection.rpc.handle('/tapcanvas', async (endpoint, payload) => {
    if (endpoint !== 'scope') {
      return failure('tapcanvas/not-found', '未知 TapCanvas 原生 RPC 方法', { endpoint })
    }
    const parsed = parseScope(payload)
    if (parsed === null) {
      return failure('tapcanvas/invalid-scope', 'TapCanvas 作用域消息缺少有效的画布标识')
    }
    const binding = await ensureWorkspace(ctx, parsed.scope)
    if (parsed.sessionId !== undefined) scopes.set(parsed.sessionId, parsed.scope)
    scopesByWorkspacePath.set(binding.workspacePath, parsed.scope)
    return success({ accepted: true, ...binding })
  })

  ctx.systemPrompt.context({
    name: 'runtime:tapcanvas-scope',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
    text: (assembly) => {
      const scope = scopeForAgent(assembly.scope)
      if (scope === null) return ''
      return JSON.stringify({
        source: 'TapCanvas 当前真实画布作用域',
        projectId: scope.projectId,
        projectName: scope.projectName,
        flowId: scope.flowId,
        chapterId: scope.chapterId,
        chapterTitle: scope.chapterTitle,
        bookId: scope.bookId,
        selectedNodeIds: scope.selectedNodeIds,
        canvas: scope.canvas,
      })
    },
  })

  ctx.systemPrompt.section({
    name: 'tool:tapcanvas-native',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WEB_FETCH'),
    text: '当前会话包含 TapCanvas 画布作用域。需要读取画布事实时调用 tapcanvas_get_current_canvas；影视创作可直接调用 film_image_gen、film_video_gen、film_video_composite、film_ask_human、film_file_read/write、film_memory_recall、film_task_create/update/list/read。若作用域缺失，必须明确报告无法读取，不得猜测项目或流程。',
  })

  ctx.tools.register(defineTool({
    name: 'tapcanvas_get_current_canvas',
    description: '读取浏览器当前 TapCanvas 画布的项目、流程、节点和边快照。没有当前作用域时返回明确错误。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (_args, exec) => {
      const scope = scopeForAgent(exec.agent)
      if (scope === null) throw new Error('TapCanvas 当前作用域不可用：请先在画布页面打开原生 Agent')
      return JSON.stringify(scope)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'film_image_gen',
    description: '直接生成图片并写入当前 TapCanvas 画布。支持文生图、参考节点/资产图生图和模型/画幅参数；调用后返回真实的节点、任务和资产状态。',
    parameters: {
      prompt: { type: 'string', description: '图片生成提示词', required: true },
      vendor: { type: 'string', enum: ['comfyui', 'newapi'], required: true, description: '必须明确选择执行器；本地模型传 comfyui，系统模型传 newapi' },
      title: { type: 'string', description: '画布节点标题' },
      tag: { type: 'string', description: '资产标签' },
      aspect_ratio: { type: 'string', description: '画幅，例如 16:9 或 1:1' },
      ai_model: { type: 'string', description: '模型目录中的模型标识' },
      prompt_template: { type: 'string', description: '可选提示词模板' },
      mode_type: { type: 'string', enum: ['text2image', 'image2image'], description: '生成模式' },
      reference_nodes: { type: 'array', items: { type: 'string' }, description: '当前画布中的参考图片节点 ID' },
      reference_assets: { type: 'array', items: { type: 'string' }, description: '已授权的参考资产 ID' },
      quality_spec: { type: 'string', description: '质量要求' },
      model_confirmation: { type: 'string', description: '模型确认信息' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args, exec) => {
      const scope = scopeForAgent(exec.agent)
      if (scope === null) throw new Error('TapCanvas 当前作用域不可用：请先在画布页面打开原生 Agent')
      return executeFilmImageGen(scope, args, exec.signal, exec.callId)
    },
  }))

  const registerFilmTool = (name: string, description: string, parameters: ParameterSchemaSpec, execute: (args: unknown, exec: ToolRunContext) => Promise<string>) => {
    ctx.tools.register(defineTool({
      name,
      description,
      parameters,
      output: { schema: { type: 'string' }, render: (_args, value: string) => [{ type: 'text' as const, text: value }] },
      execute,
    }))
  }

  const scopeOrThrow = (agent: unknown): TapCanvasScope => {
    const scope = scopeForAgent(agent)
    if (scope === null) throw new Error('TapCanvas 当前作用域不可用：请先在画布页面打开原生 Agent')
    return scope
  }

  registerFilmTool('film_video_gen', '直接生成影视分镜视频并写入当前 TapCanvas 画布，返回真实节点、任务和异步状态。', {
    prompt: { type: 'string', required: true }, title: { type: 'string', required: true }, tag: { type: 'string' }, duration_sec: { type: 'integer' }, aspect_ratio: { type: 'string' }, resolution: { type: 'string' }, ai_model: { type: 'string' }, start_frame_image_node: { type: 'string' }, end_frame_image_node: { type: 'string' }, reference_nodes: { type: 'array', items: { type: 'string' } }, reference_assets: { type: 'array', items: { type: 'string' } }, continuation_from_node: { type: 'string' }, continuation_mode: { type: 'string', enum: ['first_frame', 'reference'] }, sound: { type: 'string', enum: ['on', 'off'] }, need_bgm: { type: 'boolean' }, video_subtype: { type: 'string', enum: ['ai_transition'] },
  }, async (args, exec) => {
    const scope = scopeOrThrow(exec.agent)
    const input = readFilmVideoArguments(args)
    const nodeId = crypto.randomUUID()
    let continuationAssetId = ''
    if (input.continuation_from_node) {
      const source = scope.canvas?.nodes.find((node) => node.id === input.continuation_from_node)
      if (!source || source.data.kind !== 'video') throw new Error(`film_video_gen.continuation_from_node 不是当前画布中有效的视频节点：${input.continuation_from_node}`)
      const extraction = await executeNativeBridgeTool(scope, 'tapcanvas_video_extract_last_frame', { nodeId: input.continuation_from_node }, exec.signal, exec.callId)
      let parsed: unknown
      try { parsed = JSON.parse(extraction) as unknown } catch { throw new Error('视频尾帧抽取器返回了无法解析的回执') }
      if (!isRecord(parsed) || !Array.isArray(parsed.referenceAssetIds) || parsed.referenceAssetIds.length !== 1 || typeof parsed.referenceAssetIds[0] !== 'string' || parsed.referenceAssetIds[0].trim() === '') throw new Error('视频尾帧抽取器未返回唯一真实资产 ID')
      continuationAssetId = parsed.referenceAssetIds[0].trim()
    }
    const referenceAssets = [...(input.reference_assets ?? [])]
    if (continuationAssetId && input.continuation_mode === 'reference') referenceAssets.push(continuationAssetId)
    const nodeData: Record<string, unknown> = {
      kind: 'video', prompt: input.prompt, label: input.title,
      ...(input.tag ? { tag: input.tag } : {}), ...(input.duration_sec ? { durationSeconds: input.duration_sec } : {}),
      ...(input.aspect_ratio ? { aspect: input.aspect_ratio } : {}), ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.ai_model ? { videoModel: input.ai_model } : {}), ...(input.reference_nodes ? { referenceImageNodeIds: [...input.reference_nodes] } : {}),
      ...(referenceAssets.length ? { referenceAssetIds: [...new Set(referenceAssets)] } : {}),
      ...(input.start_frame_image_node ? { firstFrameImageNodeId: input.start_frame_image_node } : {}),
      ...(continuationAssetId && input.continuation_mode === 'first_frame' ? { firstFrameAssetId: continuationAssetId } : {}),
      ...(input.end_frame_image_node ? { lastFrameImageNodeId: input.end_frame_image_node } : {}),
      ...(input.sound ? { sound: input.sound } : {}), ...(input.need_bgm === undefined ? {} : { needBgm: input.need_bgm }), ...(input.video_subtype ? { videoSubtype: input.video_subtype } : {}),
    }
    return executeNativeBridgeTool(scope, 'tapcanvas_video_generate_to_canvas', { node: { id: nodeId, type: 'taskNode', position: { x: 0, y: 0 }, data: nodeData } }, exec.signal, exec.callId)
  })

  registerFilmTool('film_video_composite', '将已生成的视频按顺序拼接并写入当前画布。素材必须使用节点 ID；不支持把 URL 作为隐式输入。', {
    video_list: { type: 'array', items: { type: 'object', additionalProperties: true } }, audio_list: { type: 'array', items: { type: 'object', additionalProperties: true } }, reference_nodes: { type: 'array', items: { type: 'string' }, required: true }, video_volume: { type: 'number' }, audio_volume: { type: 'number' }, aspect_ratio: { type: 'string' }, resolution: { type: 'string' }, fit: { type: 'string', enum: ['contain', 'cover'] }, format: { type: 'string' }, title: { type: 'string' }, tag: { type: 'string' }, reuse_clip_node_key: { type: 'string' },
  }, async (args, exec) => {
    const scope = scopeOrThrow(exec.agent)
    const input = readFilmVideoCompositeArguments(args)
    if (input.audio_list && input.audio_list.length > 0) throw new Error('film_video_composite.audio_list 当前没有对应的 TapCanvas 原生合成执行器；请先使用支持音轨的画布节点')
    const clips = input.video_list?.map((item) => ({ nodeId: item.src, ...(item.start_position === undefined ? {} : { inSec: item.start_position }), ...(item.end_position === undefined ? {} : { outSec: item.end_position }) }))
    if (!clips || clips.length < 2) throw new Error('film_video_composite.video_list 至少需要两个视频节点')
    return executeNativeBridgeTool(scope, 'tapcanvas_video_concat', { clips, createNode: true, ...(input.aspect_ratio ? { aspect: input.aspect_ratio } : {}), ...(input.title ? { fileName: input.title } : {}), ...(input.video_volume === undefined ? {} : { videoVolume: input.video_volume }), ...(input.audio_volume === undefined ? {} : { audioVolume: input.audio_volume }) }, exec.signal, exec.callId)
  })

  registerFilmTool('film_scene_director', '编排当前画布的导演台场景。当前版本要求直接提供 TapCanvas 导演台 scene 协议；旧版 commands 指令尚未有等价执行器，会显式失败。', { commands: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true }, target_node: { type: 'string' }, base_revision: { type: 'string' } }, async () => { throw new Error('film_scene_director.commands 尚未接入 TapCanvas 导演台 scene 执行协议；请改用 tapcanvas_capture_director_scene 或 tapcanvas_render_director_clip 的 scene 参数') })

  registerFilmTool('film_video_edit', '视频后处理能力。当前 TapCanvas 没有与该自然语言 brief 对应的统一执行器，调用会显式返回能力缺口。', { brief: { type: 'string', required: true }, source_node_keys: { type: 'array', items: { type: 'string' } }, clip_node_key: { type: 'string' }, style_skill: { type: 'string' } }, async () => { throw new Error('film_video_edit 当前没有统一的 TapCanvas 原生执行器；请使用具体的节点编辑或 tapcanvas_video_concat') })

  registerFilmTool('film_ask_human', '向当前会话中的导演提问并等待结构化回答；同一时刻只允许一个问题调用。', { questions: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } }, async (args, exec) => {
    if (!isRecord(args) || !Array.isArray(args.questions) || args.questions.length === 0) throw new Error('film_ask_human.questions 不能为空')
    const questionsService = ctx.get('userQuestions') as unknown as UserQuestionsLike | undefined
    if (!questionsService) throw new Error('film_ask_human 无法执行：User Questions 服务未加载')
    const questions = args.questions.map((item, index) => {
      if (!isRecord(item)) throw new Error(`film_ask_human.questions[${index}] 必须是对象`)
      const question = readRequiredText(item, 'film_ask_human.questions', 'question')
      const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `question-${index + 1}`
      return { id, question, ...(typeof item.header === 'string' ? { header: item.header } : {}), ...(Array.isArray(item.options) ? { options: item.options.map((option, optionIndex) => { if (!isRecord(option)) throw new Error(`film_ask_human.questions[${index}].options[${optionIndex}] 必须是对象`); return { label: readRequiredText(option, 'film_ask_human.options', 'content') } }) } : {}), ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}) }
    })
    return JSON.stringify(await questionsService.ask({ questions, agent: exec.agent, signal: exec.signal }))
  })

  registerFilmTool('film_file_read', '读取当前 Agent Workspace 内的影视文件。路径只能是相对路径。', { file_path: { type: 'string', required: true } }, async (args, exec) => {
    if (!isRecord(args)) throw new Error('film_file_read 参数必须是对象')
    const scope = scopeOrThrow(exec.agent); const binding = await ensureWorkspace(ctx, scope)
    const path = workspaceFilePath(binding.workspacePath, readRequiredText(args, 'film_file_read', 'file_path'))
    return readFile(path, 'utf8')
  })

  registerFilmTool('film_file_write', '写入当前 Agent Workspace 内的影视文件。路径只能是相对路径；覆盖写入必须由调用方明确传 append=false。', { file_path: { type: 'string', required: true }, content: { type: 'string', required: true }, append: { type: 'boolean', required: true } }, async (args, exec) => {
    if (!isRecord(args)) throw new Error('film_file_write 参数必须是对象')
    const scope = scopeOrThrow(exec.agent); const binding = await ensureWorkspace(ctx, scope)
    const path = workspaceFilePath(binding.workspacePath, readRequiredText(args, 'film_file_write', 'file_path'))
    const contentValue = args.content; const append = args.append
    if (typeof contentValue !== 'string') throw new Error('film_file_write.content 必须是字符串')
    const content = contentValue
    if (typeof append !== 'boolean') throw new Error('film_file_write.append 必须是布尔值')
    await mkdir(resolve(path, '..'), { recursive: true })
    await writeFile(path, content, { encoding: 'utf8', flag: append ? 'a' : 'w' })
    return JSON.stringify({ ok: true, file_path: relative(binding.workspacePath, path), bytes: Buffer.byteLength(content, 'utf8'), append })
  })

  const taskParameters = { id: { type: 'string' }, subject: { type: 'string' }, task_content: { type: 'string' }, status: { type: 'string', enum: ['planned', 'in_progress', 'completed'] } } satisfies ParameterSchemaSpec
  registerFilmTool('film_task_create', '创建影视任务，初始状态固定为 planned，并持久化到当前画布隔离 Workspace。', { subject: { type: 'string', required: true }, task_content: { type: 'string' }, id: { type: 'string' } }, async (args, exec) => {
    if (!isRecord(args)) throw new Error('film_task_create 参数必须是对象')
    const scope = scopeOrThrow(exec.agent); return executeFilmTaskManager(await ensureWorkspace(ctx, scope), args, 'create')
  })
  registerFilmTool('film_task_update', '更新一个已存在的影视任务状态或内容。', taskParameters, async (args, exec) => {
    if (!isRecord(args)) throw new Error('film_task_update 参数必须是对象')
    const scope = scopeOrThrow(exec.agent); return executeFilmTaskManager(await ensureWorkspace(ctx, scope), args, 'update')
  })
  registerFilmTool('film_task_list', '列出当前画布隔离 Workspace 中的影视任务摘要。', {}, async (_args, exec) => {
    const scope = scopeOrThrow(exec.agent); return executeFilmTaskManager(await ensureWorkspace(ctx, scope), {}, 'list')
  })
  registerFilmTool('film_task_read', '读取一个影视任务的完整详情。', { id: { type: 'string', required: true } }, async (args, exec) => {
    if (!isRecord(args)) throw new Error('film_task_read 参数必须是对象')
    const scope = scopeOrThrow(exec.agent); return executeFilmTaskManager(await ensureWorkspace(ctx, scope), args, 'read')
  })

  registerFilmTool('film_memory_recall', '从当前用户和画布作用域的 Agent Workspace 任务记录中召回历史事实；不会猜测不存在的历史。', { goal: { type: 'string', required: true }, running_text: { type: 'string', required: true } }, async (args, exec) => {
    if (!isRecord(args)) throw new Error('film_memory_recall 参数必须是对象')
    const scope = scopeOrThrow(exec.agent); const binding = await ensureWorkspace(ctx, scope); const file = join(binding.workspacePath, '.film-tasks.json')
    const raw = await readFile(file, 'utf8').catch(() => '[]'); const parsed: unknown = JSON.parse(raw); if (!Array.isArray(parsed)) throw new Error('历史任务记录格式无效')
    return JSON.stringify({ status: parsed.length === 0 ? 'not_found' : 'found', records: parsed })
  })

  registerFilmTool('film_audio_gen', '配音生成函数。当前请使用 TapCanvas 画布的具体音频节点执行器；该影视别名尚未接入统一原生提交器。', { prompt: { type: 'string', required: true }, title: { type: 'string', required: true }, type: { type: 'string' }, ai_model: { type: 'string' }, settings_spec: { type: 'string' }, reference_nodes: { type: 'array', items: { type: 'string' } } }, async () => { throw new Error('film_audio_gen 当前没有统一的 TapCanvas 原生音频生成执行器') })
  registerFilmTool('film_sfx_gen', '音效生成函数。当前请使用 TapCanvas 画布的具体音频节点执行器；该影视别名尚未接入统一原生提交器。', { prompt: { type: 'string', required: true }, title: { type: 'string', required: true }, type: { type: 'string' }, ai_model: { type: 'string' } }, async () => { throw new Error('film_sfx_gen 当前没有统一的 TapCanvas 原生音频生成执行器') })
  registerFilmTool('film_asset_save', '把当前画布中已验收的节点同步到项目素材库。保存动作由 TapCanvas 真实素材同步执行器完成。', { node_key: { type: 'string', required: true }, asset_type: { type: 'integer', required: true }, folder_name: { type: 'string' }, name: { type: 'string' } }, async (args, exec) => {
    if (!isRecord(args)) throw new Error('film_asset_save 参数必须是对象')
    const scope = scopeOrThrow(exec.agent); const nodeId = readRequiredText(args, 'film_asset_save', 'node_key'); const assetType = args.asset_type
    if (typeof assetType !== 'number' || !Number.isInteger(assetType) || assetType < 0 || assetType > 5) throw new Error('film_asset_save.asset_type 必须是 0 到 5 的整数')
    const kindByType = ['prop', 'character', 'scene', 'prop', 'style', 'voice'] as const
    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : nodeId
    return executeNativeBridgeTool(scope, 'tapcanvas_material_assets_sync', { bindings: [{ nodeId, kind: kindByType[assetType]!, name, ...(typeof args.folder_name === 'string' && args.folder_name.trim() ? { materialIdentity: { folderName: args.folder_name.trim() } } : {}) }] }, exec.signal, exec.callId)
  })
  registerFilmTool('film_asset_search', '从当前项目素材库检索真实资产，返回可复用的素材 ID 和来源事实。', { query: { type: 'string', required: true } }, async (args, exec) => {
    if (!isRecord(args)) throw new Error('film_asset_search 参数必须是对象')
    const scope = scopeOrThrow(exec.agent); const query = readRequiredText(args, 'film_asset_search', 'query')
    return executeNativeBridgeTool(scope, 'tapcanvas_material_assets_list', { nameContains: query }, exec.signal, exec.callId)
  })
  registerFilmTool('film_color_grade', '成片调色的影视函数别名。当前统一调色执行器尚未接入该原生 Function。', { brief: { type: 'string', required: true }, source_node_keys: { type: 'array', items: { type: 'string' }, required: true }, clip_node_key: { type: 'string' }, style_skill: { type: 'string' } }, async () => { throw new Error('film_color_grade 当前没有统一的 TapCanvas 原生调色执行器') })
}

export function clearTapCanvasScope(sessionId: string): void {
  scopes.delete(sessionId)
}
