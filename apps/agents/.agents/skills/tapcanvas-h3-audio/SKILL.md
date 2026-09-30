---
name: tapcanvas-h3-audio
description: 当音频节点选择 MiniMax H3 引擎、需要音色设计（文生音色）、音色参考、多人对白或 H3 音频提示词时加载。负责把真实上下文编成 H3 可执行音频结构，并应用已验证的踩坑规则。
---

# MiniMax H3 音频生成

## 执行步骤

1. 先确认音频节点的模型目录能力标签为 `tapcanvas:audio-type=speech`，并进一步确认执行引擎标签为 `tapcanvas:audio-engine=minimax-h3`；读取节点文本、参考音频 URL 与真实角色上下文。节点参数只能来自该模型目录项的 `runtimeParameters`，不能按模型名称猜测。H3 音频没有任何模型参数：音频时长由提示词里的台词与时间轴预算推导，采样步数与可用 UNET 取工作流固定配置，节点不暴露也不接受 `duration`/`steps`/`unet`。
   - 简易模式：节点文本是普通台词时，服务端会自动按「每个非空行一句台词」组装成下方结构（开场 1 秒无人声、逐句时间戳、台词包 `<d>`），无需调用方手写段落。你仍应在需要多人对白、多角色音色绑定、精确节拍或尾帧承接时按本 Skill 手写完整结构；此时只要段落齐全就会被原样透传，不会被模板覆盖。
   - **二选一，不能混用**：纯台词文本（不要出现任何段落名）走简易模式；结构化提示词必须**段落齐全**（三段式含 `integrated_multimodal_description:` / `overall_soundscape:` / `non_diegetic_music:`，六段式另加前三段）。若写了段落名却缺必需段落，执行器会显式报「结构不完整」并指出缺失段落，不会替你补全或降级重打包——请补齐后再提交。**手写提示词时务必逐字保留段落名行**（尤其首行 `integrated_multimodal_description:`），漏掉它会让整段结构被当作台词重新打包，台词句数与时长都会失真。
   - 简易模式只是「把这段话原样念出来」，**不设计音色**。用户要求“设计一个 X 的声音”时必须走下方「音色设计」章节，手写含说话人音色描述的完整结构。
2. 有参考音频时使用 Ref2VA 六段结构；无参考音频时使用基础三段结构，并在 `<d>` 外写清说话人音色描述（见「音色设计」章节）。不要把普通剧情段落直接提交给 H3。
3. 生成后检查每句对白、说话人、时间轴和参考音色绑定，再提交音频节点：原生 Agent 直接用 `film_audio_gen` 提交（省略 `ai_model` 时按实时目录声明的 H3 语音模型执行；参考音色只传真实音频节点 ID）。缺少必要事实时显式失败。

## 必须使用的结构

无参考音频：按以下顺序输出：

```text
integrated_multimodal_description:
overall_soundscape:
non_diegetic_music:
```

有参考音频：按以下顺序输出：

```text
subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:
```

## 音色设计（无参考音的文生音色）

H3 是生成模型：**没有参考音频时，音色靠文字描述设计出来**，这是官方推荐用法，不是降级方案。
依据 MiniMax H3 官方 Video Prompt Writing Guide（T2VA / I2VA / FL2VA / L2VA）第 4.4 节：说话人首次出现时，必须在 `<d>` **外面**
给出足以确立稳定身份的信息——角色类型、年龄、性别、是否在画面内、**音高（pitch）、音色（timbre）**、语速、口音等；
`<d>` 内只放语言标签和用户提供的台词原文，逐字保留、不翻译。

触发条件：用户说“设计一个 X 的声音”“给我一个沙哑的老巫师嗓子”“要慵懒御姐音”等，都属于本场景。

正确写法（描述在 `<d>` 外，台词在 `<d>` 内；**音色设计一律干声**）：

```text
integrated_multimodal_description:
[Shot 1] A completely dry, close-miked vocal take: no room tone, no ambience, no music and no reverberation of any kind; every gap between sentences is absolutely silent. Solo spoken piece with exactly one speaker in the entire clip. (S1) is an elderly witch with a cracked, gravelly, low-pitched and raspy voice, speaking slowly and menacingly, savoring each word.
[Shot 2] At exactly 00:01.000 the witch (S1) begins speaking immediately: <d>[Chinese] 你好啊亲爱的，我等你很久了，快进来吧。</d>

overall_soundscape: N/A
non_diegetic_music: N/A
```

### 音色设计必须干声（强制）

**`overall_soundscape` 写了什么，H3 就真的会生成什么。** 在 `overall_soundscape` 里写雨、水、门、脚步、房间底噪，声音里就一定会出现这些背景声——这不是元数据，是实质指令。

音色锚点的用途是作为 Ref2VA 的参考音去锁定 timbre，参考音里的一切都会被一起克隆。**混在音色锚点里的雨声、水声、房间底噪会跟着 timbre 污染后续所有镜头**，且事后无法分离。因此音色设计场景：

- `overall_soundscape` 与 `non_diegetic_music` **必须都写 `N/A`**。
- `[Shot 1]` 里显式写明干声约束（no room tone / no ambience / no music / no reverberation / every gap absolutely silent）；只描述音色，不描写场景环境。
- **`integrated_multimodal_description` 里也不要写场景环境**（雨、水、船、房间、电梯、金属门等）。官方指南允许该段落承载画面与 diegetic audio，写了就会被生成；音色设计只需要「说话人 + 音色 + 台词」三类事实。
- 需要带环境的成品音频时，那是**分镜/对白生成**，不是音色设计：先用干净音色锚点锁 timbre，再在后续 Ref2VA 任务里按真实场景写 `overall_soundscape`。

硬性约束：

- **禁止把用户的诉求原话当台词。** 用户说“我想设计一个女巫的声音”时，`<d>` 里绝不能是这句话；`<d>` 内只能放真正要被念出来的台词（用户没给台词时，先按上下文拟一句或向用户确认）。
- **音色描述只写在 `<d>` 外。** 写进 `<d>` 内会被当作台词念出来。
- 描述维度按需组合：年龄、性别、音高（低沉/尖细）、音色质感（沙哑/气声/磁性/清脆/颗粒感）、语速、口音、语气态度、是否画外音。描述越具体，音色越可复现。
- 段落正文（`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`）按官方指南用**英文**书写；`<d>` 内的台词保持原语言，逐字不改写。
- 同一句设计描述只对应一个 `(Sx)`；多人时每人独立描述、编号按首次发声顺序稳定不变。
- **不复用简易模式。** 简易模式（节点文本是普通台词时由服务端逐行包 `<d>`）的语义是“把这段话原样念出来”，它**不设计音色**；音色设计必须由你手写含说话人描述的完整结构。
- **一致性**：H3 每次生成都会重新随机，同一段文字描述不保证跨次得到同一把嗓子。若某次结果满意且需要跨镜跨章复用同一音色，把该成品音频作为参考音连到后续音频节点，改用 Ref2VA 六段结构锁定 timbre。

## 文档中的实测避坑规则

- 每句对白必须写成 `<d>[Language] 台词原文</d>`；`Language` 必须替换为台词实际语言，例如英文用 `[English]`、日文用 `[Japanese]`、中文用 `[Chinese]`。标签内不加引号，不翻译、不改写、不增删台词；混合语言台词按该句主要发声语言标注。
- 每个实际发声者按首次发声顺序绑定稳定 `(S1)`、`(S2)` 编号，后续保持不变；直连 ComfyUI 时参考音按上游资产连线顺序使用 `<Audio 1>`、`<Audio 2>`、`<Audio 3>` 标注，不使用 `@别名`，不得交换角色音色。
- 参考音色只用于音色特征。`retention_analysis` 明确写出只保留 timbre、不得复述参考音频原话，最终台词只能来自当前任务事实。
- 在 `subject_definitions` 或 `detailed_description` 明确声明全片人物数量、每个 `(Sx)` 的唯一归属和禁止混淆；没有新增角色声音。
- 开场前约 1 秒不安排人声、杂声或呓语，第一句对白时间戳应晚于 1 秒。**这 1 秒只表示「没人声」，不表示要铺环境声**：音色设计场景这 1 秒必须是绝对静音（`overall_soundscape: N/A`）；只有分镜生成且用户明确要求环境声时，才在这 1 秒写环境声淡入。
- 对 5 秒短音频，开场镜头只写一句可见状态，禁止把人物连续动作、镜头运动或铺陈细节放在第一句对白之前；这些内容会被模型当作实际发生在对白前的时间，导致起声拖到后半段。将第一句对白写为第二镜的第一动作，并明确 `At exactly 00:01.000`、`begins speaking immediately` 与 `audible voice onset must occur no later than 00:01.200`。
- 说话必须挂在可见动作、镜头或画面状态上；用轻笑、停顿、吸气、落座等动作表达节奏，不孤立写“播放语音”。
- `[Shot 1]` 不写时间戳；后续镜头使用严格递增的 `At MM:SS.mmm`，且不超过本次台词预算出的时长。
- 语速按字符集分语种估算：中文/CJK 约 4.5 字/秒，拉丁约 10 字符/秒（实现在 `apps/hono-api/src/modules/apiKey/h3-speech-rate.ts`），另加 1 秒开场、句间约 0.6 秒停顿和收尾空间；系统按同一套规则从台词与时间轴预算推导音频时长，可行区间为 1~15 秒。**不要按中文字数给英文台词估算时长**：H3 会把台词铺满请求时长，用中文语速估英文会成倍估长并留下大片尾部静音。台词过多时删减台词或拆分为多条音频节点，不提交超出 15 秒预算的单次请求。
- `overall_soundscape` 只写环境声、动作声和非语言声音；`non_diegetic_music` 只写观众可听的配乐。**这两段是实质指令：写了就会被生成出来。** 按场景分档：
  - **音色设计 / 配音试听 / 音色锚点：两段都必须 `N/A`**，且正文不写场景环境（见上方「音色设计必须干声」）。这是默认档，用户没提环境声时一律走这里。
  - **分镜 / 对白生成且用户明确要求环境声或配乐**：才写具体声源（雨、脚步、钢琴等），并写清是哪些声音；不写「轻微的环境底噪」这类无具体声源的泛化描述——泛化描述会让模型自行发挥补出持续音床。
  - 判断依据是**用户是否明确要求**，不是「场景看起来该有什么」。用户只给了场景设定（雨夜、渡口）而没有要求音频带环境声时，仍按干声处理。
- 参考音频最多 3 条，必须来自真实资产 URL；上传顺序决定 `<Audio 1>`、`<Audio 2>`、`<Audio 3>` 映射。缺失或无法读取时显式失败。
- 可用 UNET 由执行前对 `8188` 的 `/object_info` 实时枚举决定，不通过节点参数选择；当前只注册了 `fl2va` 音频 UNET，不得建议或假设存在未在实时枚举中出现的 `ref2va`。缺 UNET、文本编码器或 VAE 时执行显式失败。
- 生成结果保留 ComfyUI 原始 FLAC 作为来源资产。默认播放的 WAV 只按静音检测裁掉真实起始静音，再保留 200ms 前导静音，避免从 0 秒硬切进人声；不做尾部响度阈值自动裁剪。**不要假设成品开头一定有 1 秒无人声预卷**：H3 的时间轴是软约束，实测多数产物从 0.0~0.6 秒就开始说话，按契约固定裁掉首秒会从人声中间切一刀，听感上就是开头被截断、起声突兀。中间停顿、呼吸、音乐和后续有效声音均不裁剪、不变速；真实时长以处理后 WAV 的 `ffprobe` 实测为准。

## 交付前检查

- 确认段落名称和顺序完整。
- 确认所有对白都有与实际语言一致的 `<d>[Language]... </d>`，发声者编号稳定，参考音色映射唯一。
- 确认开场无人声、时间戳递增且落在台词预算出的时长内。
- 确认请求使用真实参考音频 URL，未用占位节点、文本脚本或 planned metadata 冒充资产。
- 音色设计场景：确认音色描述写在 `<d>` 外、`<d>` 内只有真正的台词，且没有把用户“设计一个 X 的声音”的诉求原话当台词提交。
- 音色设计场景：**逐字确认 `overall_soundscape` 与 `non_diegetic_music` 都是 `N/A`**，且 `integrated_multimodal_description` 里没有场景环境描写（雨、水、船、房间、门、脚步等）。只要这两段或正文写了环境声，生成的音色锚点就会被背景声污染，作为参考音克隆到后续所有镜头。用户明确要求环境声的情况除外，且此时不属于音色设计。
- 只提交结构完整且事实可追溯的 prompt；不以本地关键词替代 Agent 的角色、情绪或剧情判断。
