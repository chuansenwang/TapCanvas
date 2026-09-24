---
name: tapcanvas-api
description: TapCanvas 当前画布的原生 Agent 工具说明。
---

# TapCanvas 当前画布工具

本 Skill 只描述当前画布的 owner-scoped 原生工具。当前画布中的读取、节点创建、媒体生成和结果查询由 Agent 内置函数完成，不使用外部 MCP、shell、脚本或人工拼接 HTTP 请求。

## 当前画布操作

- 读取当前画布事实时使用原生画布读取工具，并只使用返回的真实项目、Flow、节点和边 ID。
- 创建或修改节点时使用 `tapcanvas_flow_patch`，提交前确认当前会话已有真实画布作用域。
- 用户直接要求生成图片时，优先一次调用内置函数 `film_image_gen`，不要先读取画布、探查端口、查找 token 或执行 MCP schema discovery。函数会把结果写入当前画布，并返回真实的节点、任务和资产状态。调用必须显式传 `vendor`：本地 ComfyUI 模型传 `vendor: "comfyui"`，系统模型传 `vendor: "newapi"`；只传模型名或省略执行器会直接失败，不进入默认 new-api 路径。
- 需要使用完整节点协议、批量节点或图片生成回执时，使用 `tapcanvas_image_generate_to_canvas`；执行视频、音频或其他媒体任务时使用对应的原生画布工具。
- 任务状态和结果必须以工具返回的真实 `taskId`、终态和资产 URL 为准。缺少作用域、节点或真实前置资产时显式失败，不猜测 ID，不制造占位结果。
- 图片模型和供应商从当前节点保存的配置及运行时模型目录解析；内置函数使用与当前用户绑定的短期内部委托鉴权，不在提示词中要求用户填写外部凭证，也不向模型暴露内部委托凭据。
- 画布图片节点的“角色组件”工具栏操作会调用本机 See-through，把已有二次元单角色图片拆成语义化透明 RGBA 部件并落入画布。当前没有对应的原生 Agent Function；Agent 不得假称已调用该能力或改用通用云端分层替代。它只接受真实可访问的源图片 URL，且配置、推理或部件元数据任一失败时都会显式失败。
- See-through 拆分成功后的图片节点可在画布工具栏触发“组件动画”：它把已托管的 RGBA 部件、原图坐标、深度和关键帧交给 HyperFrames，渲染确定性的二维 MP4。当前也没有对应的原生 Agent Function；Agent 不得假称已调用该工具栏能力，不能把它替换为生成式视频。它只重组真实部件，不会补画缺失肢体、场景或角色；缺少部件 URL、渲染器或对象存储时会显式失败。

## 影视 Function

影视工具已作为原生 Agent Function 注册，不是外部 MCP。可直接调用：

- `film_image_gen`：提交图片节点并返回真实任务回执。参考图数量按所选图片模型的能力决定，不写死张数：模型目录 `meta.imageOptions.maxReferenceImages` 声明该模型单次执行的参考图上限（本地 `qwen-image-2.1` 图编辑为 16 张），未声明时沿用节点默认上限；超出上限时后端按上限截断并在节点日志记录，低于模型下限或模型不支持参考图时显式失败。
- `film_video_gen`：提交视频节点并返回真实异步任务回执。相邻视频不默认连续；场景切换使用独立镜头。只有明确需要动作接力时才传 `continuation_from_node` 与 `continuation_mode`，工具会从当前画布真实上游视频抽取尾帧并登记为资产，`first_frame` 用作首帧，`reference` 用作全参考素材，二者不能混用。需要自定义 ComfyUI 工作流时，显式传 `workflow_capability`；`reference-audio-legacy` 必须同时提供当前画布中已生成的真实角色/场景图片和对白音频，运行时按工作流声明的顺序传入，不能把音频仅写在 prompt 里代替媒体输入。多角色对话应先确认每个角色图片与对应音频节点已取得真实资产 URL，再提交视频；只返回 `queued`/`running` 时不得宣称视频已完成。
- `film_video_composite`：使用真实视频节点 ID 调用拼接执行器；成功后会在当前画布自动创建合片 `composeVideo` 节点，并建立源视频到合片节点的顺序连线，返回真实合片节点 ID 与资产 URL。
- `film_ask_human`：通过当前会话的用户提问服务等待导演回答。
- `film_file_read`、`film_file_write`：在当前画布隔离的 Agent Workspace 中读写相对路径文件。
- `film_memory_recall`：从当前隔离 Workspace 的影视任务记录中召回历史；没有记录时返回 `not_found`。
- `film_task_create`、`film_task_update`、`film_task_list`、`film_task_read`：管理当前隔离 Workspace 的影视任务清单。
- `film_asset_search` / `film_asset_save`：分别调用项目素材列举和素材同步执行器，使用真实节点 ID，不返回或复制存储 URL。

以下附件别名也已注册，但当前仓库没有对应的统一原生执行器，因此调用会返回明确能力错误，不会伪造成功：`film_scene_director`（旧 commands 协议）、`film_video_edit`、`film_audio_gen`、`film_sfx_gen`、`film_color_grade`。已有具体 TapCanvas 工具时，应直接使用其真实协议，例如 `tapcanvas_capture_director_scene`、`tapcanvas_render_director_clip`、`tapcanvas_material_assets_list`。

音频节点使用动态模型目录。模型必须带 `tapcanvas:audio-type=speech` 或 `tapcanvas:audio-type=music` 能力标签；节点右侧参数只允许使用所选目录项的 `meta.runtimeParameters`，不得按模型名称维护静态参数表或自动补默认模型。模型能力、价格、路由或参数契约缺失时必须显式失败。模型带 `tapcanvas:audio-engine=minimax-h3` 标签时，执行端调用后端显式配置的 `MINIMAX_H3_TTS_BASE_URL`（本机默认 `http://127.0.0.1:8188`）直连 ComfyUI：上传真实上游参考音频、提交 H3 工作流、轮询任务历史并读取音频产物；H3 音频没有任何模型参数，只接受 `prompt`：音频时长由提示词里的台词与时间轴预算推导，采样步数与可用 UNET 取工作流固定配置并由执行前 `/object_info` 实时枚举校验，节点不暴露也不接受 `duration`/`steps`/`unet`，最多 3 条参考音频。H3 语音支持简易模式：节点文本是普通台词时后端会自动组装成结构化提示词（每行一句、开场 1 秒无人声、逐句时间戳、台词包 `<d>`），已是完整结构则原样透传；需要多人对白与多角色音色绑定时仍应按 `tapcanvas-h3-audio` Skill 手写结构。服务未配置、参考资产缺失或下载失败时必须显式失败，不得改走其他 TTS 引擎。`audioType` 是模型能力的投影；`voice_card` 仅是可复用音色锚的特殊节点模式，不重新筛选模型类型。

选择 MiniMax H3 音频模型、处理 H3 多人对白，或用户要求设计某个声音/音色（如“设计一个女巫的声音”）时，先加载 `tapcanvas-h3-audio` Skill；其中的六段式/三段式结构、`<d>` 台词、`(Sx)` 音色绑定、开场无人声、时间轴与时长预算是执行前合同。无参考音频时音色靠 `<d>` 外的说话人描述设计（年龄/性别/音高/音色质感/语速/口音），不要把用户的诉求原话当作台词。

## 失败与交付

- 原生工具返回错误时保留错误码、诊断和工具调用事实，禁止改走公共 API 或静默降级。
- `queued` / `running` 只表示任务尚未结束；只有真实终态和资产 URL 才构成媒体交付证据。
- 当前画布操作完成后，回答实际写入的节点、任务状态和资产事实。
- 合片工具的成功回执必须同时包含合片资产 URL 与画布节点回执；只有 URL 没有节点 ID 不构成“已写入画布”。
