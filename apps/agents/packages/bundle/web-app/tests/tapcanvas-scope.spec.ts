import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  FILM_FUNCTION_NAMES,
  parseFilmAudioGenArguments,
  parseFilmImageGenArguments,
  parseFilmVideoGenArguments,
  registerTapCanvasRuntime,
  tapCanvasWorkspaceKey,
  type TapCanvasScope,
} from '../src/tapcanvas-scope.ts'
import { projectCharacterCardNodeData } from '../src/character-card-contract.ts'

const scope = (overrides: Partial<TapCanvasScope> = {}): TapCanvasScope => ({
  projectId: 'project-1',
  projectName: '项目一',
  flowId: 'flow-1',
  chapterId: 'chapter-1',
  chapterTitle: '第一章',
  bookId: 'book-1',
  selectedNodeIds: [],
  canvas: null,
  ...overrides,
})

describe('TapCanvas 工作区绑定', () => {
  it('同一画布作用域生成稳定键，字段空值不会产生不确定结果', () => {
    expect(tapCanvasWorkspaceKey(scope())).toBe(tapCanvasWorkspaceKey(scope()))
    expect(tapCanvasWorkspaceKey(scope({ projectName: '另一个名称' })))
      .toBe(tapCanvasWorkspaceKey(scope()))
  })

  it('不同画布作用域生成不同键，避免会话和工作区串用', () => {
    expect(tapCanvasWorkspaceKey(scope({ projectId: 'project-2' })))
      .not.toBe(tapCanvasWorkspaceKey(scope()))
    expect(tapCanvasWorkspaceKey(scope({ flowId: 'flow-2' })))
      .not.toBe(tapCanvasWorkspaceKey(scope()))
  })

  it('切换画布作用域时不会将当前旧会话附加到新工作区', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'tapcanvas-scope-'))
    const originalDshHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    let attachCalls = 0
    const handlers = new Map<string, (endpoint: string, payload: unknown) => Promise<unknown>>()
    const workspace = {
      id: 'new-canvas-workspace',
      attachSession: async (_sessionId: string): Promise<void> => { attachCalls += 1 },
    }
    const ctx = {
      connection: {
        rpc: {
          handle: (path: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>): (() => void) => {
            handlers.set(path, handler)
            return () => { handlers.delete(path) }
          },
        },
      },
      sessions: { get: (_sessionId: string): object => ({}) },
      get: (name: string): unknown => name === 'workspaceRegistry'
        ? { create: async (): Promise<typeof workspace> => workspace, get: (_id: string): typeof workspace => workspace }
        : undefined,
      systemPrompt: {
        context: (_entry: unknown): void => {},
        getContextOrder: (_name: string): number => 0,
        section: (_entry: unknown): void => {},
        getSectionOrder: (_name: string): number => 0,
      },
      tools: { register: (_tool: unknown): void => {} },
    } as unknown as Context

    try {
      registerTapCanvasRuntime(ctx)
      const handler = handlers.get('/tapcanvas')
      if (handler === undefined) throw new Error('TapCanvas scope RPC handler 未注册')
      const result = await handler('scope', {
        args: {
          sessionId: 'old-canvas-session',
          scope: scope({ projectId: `project-${randomUUID()}` }),
        },
      })

      expect(result).toMatchObject({ ok: true })
      expect(attachCalls).toBe(0)
    } finally {
      if (originalDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalDshHome
      await rm(dshHome, { recursive: true, force: true })
    }
  })
})

describe('影视原生 Function 契约', () => {
  it('图片生成必须显式选择执行器，避免本地模型隐式进入 new-api', () => {
    expect(() => parseFilmImageGenArguments({ prompt: '一只小狗' })).toThrow('vendor 必须明确指定')
    expect(parseFilmImageGenArguments({ prompt: '一只小狗', vendor: 'comfyui', ai_model: 'z-image' }))
      .toMatchObject({ prompt: '一只小狗', vendor: 'comfyui', ai_model: 'z-image' })
  })

  it('普通生图不会被隐式升级成角色卡', () => {
    const parsed = parseFilmImageGenArguments({ prompt: '一只小狗', vendor: 'comfyui' })
    expect(parsed).not.toHaveProperty('characterCardIdentity')
  })

  it('半份角色卡字段显式失败，不静默退化成普通图片', () => {
    expect(() => parseFilmImageGenArguments({
      prompt: '角色身份板',
      vendor: 'comfyui',
      role_name: '林小满',
    })).toThrow('character_asset_role')
    expect(() => parseFilmImageGenArguments({
      prompt: '角色身份板',
      vendor: 'comfyui',
      identity_anchors: ['圆脸，下颌线柔和'],
    })).toThrow('role_name')
  })

  it('角色卡必须携带四视图身份板合同与身份事实', () => {
    const identityBoardSpec = {
      layout: 'identity_board_four_view',
      faceViews: ['front', 'three_quarter'],
      fullBodyViews: ['front', 'back'],
      crossViewConsistency: true,
      referenceRoleIsolation: true,
      neutralReferenceBackground: true,
      readableTextVisible: false,
      brandingVisible: false,
      neutralBaseState: true,
      canonicalNameVisible: false,
      ipSafeOriginal: true,
    }
    const baseRequest = {
      prompt: '角色身份板',
      vendor: 'comfyui',
      character_asset_role: 'identity_anchor',
      role_name: '林小满',
      identity_board_spec: identityBoardSpec,
      identity_anchors: ['圆脸，下颌线柔和', '黑色齐肩直发，中分'],
      prohibited_drift: ['不得改成短发'],
    }
    const parsed = parseFilmImageGenArguments(baseRequest)
    expect(parsed.characterCardIdentity).toMatchObject({
      roleName: '林小满',
      characterAssetRole: 'identity_anchor',
      identityAnchors: ['圆脸，下颌线柔和', '黑色齐肩直发，中分'],
      prohibitedDrift: ['不得改成短发'],
    })
    expect(projectCharacterCardNodeData(parsed.characterCardIdentity!)).toMatchObject({
      referenceType: 'character',
      roleName: '林小满',
      characterAssetRole: 'identity_anchor',
      characterProfileVersion: 'character-card/v3',
      identityBoardSpec,
    })

    expect(() => parseFilmImageGenArguments({ ...baseRequest, role_name: '' }))
      .toThrow('role_name 不能为空')
    expect(() => parseFilmImageGenArguments({ ...baseRequest, identity_anchors: [] }))
      .toThrow('identity_anchors 不能为空')
    expect(() => parseFilmImageGenArguments({ ...baseRequest, prohibited_drift: [] }))
      .toThrow('prohibited_drift 不能为空')
    expect(() => parseFilmImageGenArguments({
      ...baseRequest,
      identity_board_spec: { ...identityBoardSpec, faceViews: ['three_quarter', 'front'] },
    })).toThrow('faceViews 必须严格为 [front, three_quarter]')
    expect(() => parseFilmImageGenArguments({
      ...baseRequest,
      identity_board_spec: { ...identityBoardSpec, fullBodyViews: ['front', 'front'] },
    })).toThrow('fullBodyViews 必须严格为 [front, back]')
    expect(() => parseFilmImageGenArguments({
      ...baseRequest,
      identity_board_spec: { ...identityBoardSpec, canonicalNameVisible: true },
    })).toThrow('canonicalNameVisible 必须为 false')
    expect(() => parseFilmImageGenArguments({
      ...baseRequest,
      identity_board_spec: { ...identityBoardSpec, renderingMode: 'photorealistic_studio_photography' },
    })).toThrow('未支持字段')
  })

  it('状态卡必须引用精确上游身份资产，不得独立文生图另起一张脸', () => {
    const stateRequest = {
      prompt: '角色状态卡',
      vendor: 'comfyui',
      character_asset_role: 'state_variant',
      role_name: '林小满',
      identity_board_spec: {
        layout: 'identity_board_four_view',
        faceViews: ['front', 'three_quarter'],
        fullBodyViews: ['front', 'back'],
        crossViewConsistency: true,
        referenceRoleIsolation: true,
        neutralReferenceBackground: true,
        readableTextVisible: false,
        brandingVisible: false,
        neutralBaseState: true,
        canonicalNameVisible: false,
        ipSafeOriginal: true,
      },
      identity_anchors: ['黑色齐肩直发，中分'],
      prohibited_drift: ['不得改用卷发'],
      state_key: 'wet',
      state_description: '被雨淋湿，头发贴脸',
    }
    expect(() => parseFilmImageGenArguments(stateRequest)).toThrow('必须引用精确的上游角色资产')
    expect(parseFilmImageGenArguments({ ...stateRequest, reference_nodes: ['card-1'] }))
      .toMatchObject({
        characterCardIdentity: {
          characterAssetRole: 'state_variant',
          stateKey: 'wet',
          stateDescription: '被雨淋湿，头发贴脸',
        },
      })
    expect(() => parseFilmImageGenArguments({ ...stateRequest, reference_nodes: ['card-1'], state_key: '' }))
      .toThrow('state_key')
  })

  it('包含附件主工具及任务管理展开函数', () => {
    expect(FILM_FUNCTION_NAMES).toEqual(expect.arrayContaining([
      'film_image_gen',
      'film_video_gen',
      'film_video_composite',
      'film_scene_director',
      'film_video_edit',
      'film_ask_human',
      'film_memory_recall',
      'film_file_write',
      'film_file_read',
      'film_task_create',
      'film_task_update',
      'film_task_list',
      'film_task_read',
    ]))
    expect(FILM_FUNCTION_NAMES).toHaveLength(18)
  })

  it('视频生成可显式携带自定义工作流能力，不会隐式填充', () => {
    expect(parseFilmVideoGenArguments({ prompt: '角色对话', title: '测试镜头' }))
      .not.toHaveProperty('workflow_capability')
    expect(parseFilmVideoGenArguments({
      prompt: '角色对话',
      title: '测试镜头',
      workflow_capability: 'reference-audio-legacy',
    })).toMatchObject({ workflow_capability: 'reference-audio-legacy' })
  })

  it('配音生成默认不指定模型，由服务端按实时目录解析 MiniMax H3 语音执行器', () => {
    expect(parseFilmAudioGenArguments({ prompt: '第一句台词', title: '旁白' }))
      .toEqual({ prompt: '第一句台词', title: '旁白' })
    expect(parseFilmAudioGenArguments({
      prompt: '第一句台词',
      title: '旁白',
      type: 'music',
      ai_model: 'minimax-h3-speech',
      reference_nodes: ['audio-1'],
    })).toMatchObject({
      audio_type: 'music',
      ai_model: 'minimax-h3-speech',
      reference_nodes: ['audio-1'],
    })
    expect(() => parseFilmAudioGenArguments({ prompt: '台词', title: '旁白', type: 'voice_card' }))
      .toThrow('type 只能是 speech 或 music')
    expect(() => parseFilmAudioGenArguments({
      prompt: '台词',
      title: '旁白',
      reference_nodes: ['a', 'b', 'c', 'd'],
    })).toThrow('最多 3 个')
  })

  it('合片音轨按音频节点 ID 透传，不再声明能力缺口', () => {
    // 回归点：audio_list 曾以「没有对应的原生合成执行器」直接抛错，
    // 而服务端 concat 早已支持 audioNodeIds 合入外部音轨。
    const source = readFileSync(new URL('../src/tapcanvas-scope.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('film_video_composite.audio_list 当前没有对应的 TapCanvas 原生合成执行器')
    expect(source).toContain("tapcanvas_video_concat', { clips, createNode: true, ...(audioNodeIds.length ? { audioNodeIds } : {})")
  })

  it('合片素材来源是 video_list，reference_nodes 不再必填', () => {
    // 回归点：工具曾把 reference_nodes 声明为 `required: true`，但服务端
    // `tapcanvas_video_concat` 只读 clips/audioNodeIds，从不读 reference_nodes。
    // 于是调用方只传 reference_nodes 时，报错指向一个并不承载素材的参数，
    // 把「漏传 video_list」误诊成「节点不够」。
    const source = readFileSync(new URL('../src/tapcanvas-scope.ts', import.meta.url), 'utf8')
    expect(source).toContain("video_list: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true }")
    expect(source).not.toContain("reference_nodes: { type: 'array', items: { type: 'string' }, required: true }")
    // 缺 video_list 的报错必须自证素材来源，而不是把 reference_nodes 当输入。
    expect(source).toContain('请用 [{ src: "<视频节点ID>" }, ...] 按拼接顺序给出，reference_nodes 不是素材来源')
  })

  it('媒体模型目录工具已注册，且要求先读目录再提交生成', () => {
    const source = readFileSync(new URL('../src/tapcanvas-scope.ts', import.meta.url), 'utf8')
    expect(source).toContain("registerFilmTool('film_media_catalog_get'")
    expect(source).toContain('tapcanvas_media_execution_catalog_get')
    // 提示段必须要求先取实时目录，禁止凭记忆填模型
    expect(source).toContain('必须先调用 film_media_catalog_get')
  })

  it('提问工具的选项契约遵循 Harness 标准 {label, description}', () => {
    const source = readFileSync(new URL('../src/tapcanvas-scope.ts', import.meta.url), 'utf8')
    // 回归点：曾要求 option.content，而 Harness 的标准选项字段是 label/description。
    expect(source).toContain("readRequiredText(option, 'film_ask_human.options', 'label')")
    expect(source).not.toContain("readRequiredText(option, 'film_ask_human.options', 'content')")
  })
})
