---
name: tapcanvas-character-card
description: 生成或修订角色卡时使用。角色卡生成方法论的唯一权威：定义 identity_board_four_view 身份板结构、identityAnchors/prohibitedDrift 证据要求、character-card/v3 节点字段契约与状态卡派生规则。
---

# TapCanvas 角色卡

## 何时使用

- 用户要求生成、重做或修订某个角色的角色资产、角色卡、人物设定图、角色三视图/身份板
- 分镜或镜头生产前需要为「本章会重复出现、后续多个镜头要复用」的角色建立身份锚点
- 已生成的角色卡需要新增年龄/造型/伤势等可见状态版本

## 输入证据

- 角色事实：姓名、年龄段、性别、身份与职业、体型与骨相、发型剪影、基准服装结构、核心配饰、身份道具
- 项目画风事实：项目 Style Bible / style lock（只提供项目级画风，不提供角色五官设计）
- 已有资产：同名角色卡的 `imageUrl`、node / asset / version ID（状态卡必须引用精确上游）

缺少角色事实时先补事实或向用户确认，不得用「通用好看角色」的模板设定填空。

## identity_board_four_view（身份板唯一结构）

角色卡生成方法论的唯一权威。基础身份板是 `characterAssetRole=identity_anchor`，必须声明 `identityBoardSpec`：

```text
identityBoardSpec:
  layout: identity_board_four_view
  faceViews: [front, three_quarter]
  fullBodyViews: [front, back]
  crossViewConsistency: true
  referenceRoleIsolation: true
  neutralReferenceBackground: true
  readableTextVisible: false
  brandingVisible: false
  neutralBaseState: true
  canonicalNameVisible: false
  ipSafeOriginal: true
```

四个信息区固定为**正面脸、3/4 脸、正面全身、背面全身**。视图顺序是合同的一部分，不得重排、去重或增删：

- `faceViews` 必须是 `[front, three_quarter]`，顺序不可反。
- `fullBodyViews` 必须是 `[front, back]`，顺序不可反、不可重复。
- 四个信息区使用同一套身份事实，跨视图必须一致；中性表情、中性站姿、统一尺度、统一光线、中性参考背景。
- 画面内不得出现任何文字、字母、数字、标签、水印、Logo 或品牌标识；canonical 角色名只存在于节点字段，绝不渲染进图。

## 证据字段

- `identityAnchors`：3-6 个画面可验证、跨镜必须稳定的身份事实，例如骨相、发型剪影、体型、核心配饰、基准服装结构或身份道具。禁止抽象评价（「气质独特」「很有魅力」这类不算事实）。
- `prohibitedDrift`：仅基于正文或既有角色事实的禁止偏移项，例如「不得换成短发」「不得去掉左眉疤」。不得凭空补设定，也不得用固定人脸负向词或模板禁词代替人物设计。

## 节点字段契约

角色卡落到画布时必须是独立 `image` 节点（编辑派生用 `imageEdit`），并同时携带机器身份：

- `referenceType: "character"`
- `roleName`：canonical 角色名。章节号与版本号永不进 name（`张三(ch3)`、`张三·v3` 会裂成每章一个新资产）。
- `characterAssetRole: "identity_anchor"`（基础身份卡）
- `characterProfileVersion: "character-card/v3"`
- `identityBoardSpec`、`identityAnchors`、`prohibitedDrift`

`film_image_gen` 已暴露这些字段，直接作为参数传入即可；运行时把它们持久化到节点数据，并在生成成功后按 `characterProfileVersion` 自动注册进项目素材库。

缺任一机器身份字段时，该图不会被项目素材库识别为角色卡，后续镜头也无法按 `@角色名` 复用；这不构成可交付的角色资产。

## prompt 编译

图片模型只执行 `prompt`，身份板结构由 `identityBoardSpec` 声明。编译 prompt 时：

- 明确写出四视图的信息区与顺序（正面脸、3/4 脸、正面全身、背面全身），写明同尺度、同光线、中性站姿与中性参考背景。
- 把 `identityAnchors` 逐条写进正向描述；把 `prohibitedDrift` 写成禁止项。
- 人物体型、媒介、镜头与生活痕迹由角色事实 + 项目画风决定。**不强制九头身、真人写实、特定镜头焦段**，也不得默认某个打光或影棚设定。
- 不得输出画风、媒介、渲染或造型流派标签去「增强一致性」；画风由项目 Style Bible 与参考图承担。

## 状态卡派生

角色的年龄、造型、伤势、服装等可见状态变化用**派生卡**表达，不得覆盖基础卡：

- `characterAssetRole: "state_variant"`
- 同时给出 `stateKey`、`stateVersionId`、`stateDescription` 与该状态的可见事实
- 必须引用精确的上游基础卡或上一状态的 node / asset / version ID 做 image-edit，不得用独立文生图另起一张脸

## 禁止项

- 不得在同一张角色卡里混入第二个人物、场景叙事或剧情动作；角色卡只锁身份，不承担分镜。
- 不得用「长得像同一家人」这类含糊措辞代替具体身份事实。
- 不得用随机瑕疵池或「活人感」随机设定代替从角色事实推导的可见特征。
- 不得把参考图职责混用：参考图各自只负责身份、布局、内容或风格，职责必须显式隔离。

## 交付前检查

- `identityBoardSpec` 四视图齐全、顺序正确、跨视图一致。
- `identityAnchors` 与 `prohibitedDrift` 都能回溯到已确认事实，没有抽象评价与凭空设定。
- 机器身份字段（`referenceType` / `roleName` / `characterAssetRole` / `characterProfileVersion`）齐全。
- 画面无文字、无品牌、无第二人物。
- 状态卡引用的是精确上游身份资产，而不是重新设计一张脸。
