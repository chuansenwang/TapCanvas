/**
 * 角色卡（character-card/v3）结构契约。
 *
 * 与 Hono 侧 `character-identity-board-contract.ts` 的 `identity_board_four_view`
 * 保持同一份结构事实：正面脸、3/4 脸、正面全身、背面全身，跨视图一致、参考职责隔离、
 * 中性参考背景、无文字、无品牌。这里只做结构校验与 node data 投影，不决定角色设计；
 * 角色事实、体型、媒介、镜头与生活痕迹由 `tapcanvas-character-card` skill 编译。
 */

/** 新角色卡唯一结构版本号。 */
export const CHARACTER_PROFILE_VERSION = 'character-card/v3'

/** 身份板唯一布局标识。 */
export const CHARACTER_IDENTITY_BOARD_LAYOUT = 'identity_board_four_view'

/** 角色图片资产的两种职责。 */
export type CharacterAssetRole = 'identity_anchor' | 'state_variant'

/** 四视图身份板结构合同。 */
export interface CharacterIdentityBoardSpec {
  readonly layout: typeof CHARACTER_IDENTITY_BOARD_LAYOUT
  readonly faceViews: readonly ['front', 'three_quarter']
  readonly fullBodyViews: readonly ['front', 'back']
  readonly crossViewConsistency: true
  readonly referenceRoleIsolation: true
  readonly neutralReferenceBackground: true
  readonly readableTextVisible: false
  readonly brandingVisible: false
  readonly neutralBaseState: true
  readonly canonicalNameVisible: false
  readonly ipSafeOriginal: true
}

/** 已校验的角色卡身份事实，供 node data 投影使用。 */
export interface CharacterCardIdentity {
  readonly roleName: string
  readonly characterAssetRole: CharacterAssetRole
  readonly identityBoardSpec: CharacterIdentityBoardSpec
  readonly identityAnchors: readonly string[]
  readonly prohibitedDrift: readonly string[]
  readonly stateKey?: string
  readonly stateDescription?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取一个必须为 true 的结构标记；缺失或非 true 一律拒绝。 */
function readTrueFlag(spec: Record<string, unknown>, key: string, path: string): true {
  if (spec[key] !== true) throw new Error(`${path}.${key} 必须为 true`)
  return true
}

/** 读取一个必须为 false 的结构标记；缺失或非 false 一律拒绝。 */
function readFalseFlag(spec: Record<string, unknown>, key: string, path: string): false {
  if (spec[key] !== false) throw new Error(`${path}.${key} 必须为 false`)
  return false
}

/** 读取固定顺序的视图序列；顺序、数量与取值任一不符即拒绝。 */
function readViewSequence(
  spec: Record<string, unknown>,
  key: string,
  path: string,
  expected: readonly string[],
): readonly [string, string] {
  const value = spec[key]
  const actual = Array.isArray(value) ? value : []
  if (actual.length !== expected.length || expected.some((item, index) => actual[index] !== item)) {
    throw new Error(`${path}.${key} 必须严格为 [${expected.join(', ')}]`)
  }
  const [first, second] = expected
  if (first === undefined || second === undefined) {
    throw new Error(`${path}.${key} 期望的视图序列为空`)
  }
  return [first, second]
}

/** 校验并归一化四视图身份板结构；多余字段、旧布局与旧默认值一律拒绝。 */
export function parseCharacterIdentityBoardSpec(
  value: unknown,
): CharacterIdentityBoardSpec {
  const path = 'identity_board_spec'
  if (!isRecord(value)) throw new Error(`${path} 必须是对象`)
  if (value.layout !== CHARACTER_IDENTITY_BOARD_LAYOUT) {
    throw new Error(`${path}.layout 必须是 ${CHARACTER_IDENTITY_BOARD_LAYOUT}`)
  }
  const [faceFront, faceThreeQuarter] = readViewSequence(
    value,
    'faceViews',
    path,
    ['front', 'three_quarter'],
  )
  const [bodyFront, bodyBack] = readViewSequence(
    value,
    'fullBodyViews',
    path,
    ['front', 'back'],
  )
  const spec: CharacterIdentityBoardSpec = {
    layout: CHARACTER_IDENTITY_BOARD_LAYOUT,
    faceViews: [faceFront as 'front', faceThreeQuarter as 'three_quarter'],
    fullBodyViews: [bodyFront as 'front', bodyBack as 'back'],
    crossViewConsistency: readTrueFlag(value, 'crossViewConsistency', path),
    referenceRoleIsolation: readTrueFlag(value, 'referenceRoleIsolation', path),
    neutralReferenceBackground: readTrueFlag(value, 'neutralReferenceBackground', path),
    readableTextVisible: readFalseFlag(value, 'readableTextVisible', path),
    brandingVisible: readFalseFlag(value, 'brandingVisible', path),
    neutralBaseState: readTrueFlag(value, 'neutralBaseState', path),
    canonicalNameVisible: readFalseFlag(value, 'canonicalNameVisible', path),
    ipSafeOriginal: readTrueFlag(value, 'ipSafeOriginal', path),
  }
  const allowed = new Set(Object.keys(spec))
  const unknownKeys = Object.keys(value).filter(key => !allowed.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(
      `${path} 含未支持字段 ${unknownKeys.join('、')}；四视图合同不含体型、媒介、镜头或随机瑕疵等旧默认值`,
    )
  }
  return spec
}

/** 读取非空字符串数组；空数组视为未声明。 */
function readFactList(value: unknown, path: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path} 必须是字符串数组`)
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${path}[${index}] 必须是非空字符串`)
    }
    return item.trim()
  })
}

/**
 * 校验角色卡身份事实。基础身份卡要求四视图合同、身份锚点与禁止漂移项齐全；
 * 状态卡额外要求 stateKey/stateDescription，且必须由调用方给出精确上游引用。
 */
export function parseCharacterCardIdentity(input: {
  roleName: unknown
  characterAssetRole: unknown
  identityBoardSpec: unknown
  identityAnchors: unknown
  prohibitedDrift: unknown
  stateKey: unknown
  stateDescription: unknown
  hasUpstreamReference: boolean
}): CharacterCardIdentity {
  const roleName = typeof input.roleName === 'string' ? input.roleName.trim() : ''
  if (!roleName) throw new Error('film_image_gen.role_name 不能为空：角色卡必须声明 canonical 角色名')
  const characterAssetRole = input.characterAssetRole
  if (characterAssetRole !== 'identity_anchor' && characterAssetRole !== 'state_variant') {
    throw new Error('film_image_gen.character_asset_role 只能是 identity_anchor 或 state_variant')
  }
  const identityBoardSpec = parseCharacterIdentityBoardSpec(input.identityBoardSpec)
  const identityAnchors = readFactList(input.identityAnchors, 'identity_anchors')
  if (identityAnchors.length === 0) {
    throw new Error('film_image_gen.identity_anchors 不能为空：角色卡必须给出可验证的跨镜身份事实')
  }
  const prohibitedDrift = readFactList(input.prohibitedDrift, 'prohibited_drift')
  if (prohibitedDrift.length === 0) {
    throw new Error('film_image_gen.prohibited_drift 不能为空：角色卡必须给出基于事实的禁止偏移项')
  }
  const stateKey = typeof input.stateKey === 'string' && input.stateKey.trim() ? input.stateKey.trim() : undefined
  const stateDescription =
    typeof input.stateDescription === 'string' && input.stateDescription.trim()
      ? input.stateDescription.trim()
      : undefined
  if (characterAssetRole === 'state_variant') {
    if (!stateKey) throw new Error('状态卡必须提供 state_key')
    if (!stateDescription) throw new Error('状态卡必须提供 state_description')
    if (!input.hasUpstreamReference) {
      throw new Error(
        '状态卡必须引用精确的上游角色资产（reference_nodes 或 reference_assets），不得独立文生图另起一张脸',
      )
    }
  }
  return {
    roleName,
    characterAssetRole,
    identityBoardSpec,
    identityAnchors,
    prohibitedDrift,
    ...(stateKey ? { stateKey } : {}),
    ...(stateDescription ? { stateDescription } : {}),
  }
}

/** 把已校验的角色卡身份投影为画布节点数据字段；未声明的可选字段不写入。 */
export function projectCharacterCardNodeData(identity: CharacterCardIdentity): Record<string, unknown> {
  return {
    referenceType: 'character',
    roleName: identity.roleName,
    characterAssetRole: identity.characterAssetRole,
    characterProfileVersion: CHARACTER_PROFILE_VERSION,
    identityBoardSpec: identity.identityBoardSpec,
    identityAnchors: [...identity.identityAnchors],
    prohibitedDrift: [...identity.prohibitedDrift],
    ...(identity.stateKey ? { stateKey: identity.stateKey } : {}),
    ...(identity.stateDescription ? { stateDescription: identity.stateDescription } : {}),
  }
}
