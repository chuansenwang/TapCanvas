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

## 影视 Function

影视工具已作为原生 Agent Function 注册，不是外部 MCP。可直接调用：

- `film_image_gen`：提交图片节点并返回真实任务回执。
- `film_video_gen`：提交视频节点并返回真实异步任务回执。
- `film_video_composite`：使用真实视频节点 ID 调用拼接执行器。
- `film_ask_human`：通过当前会话的用户提问服务等待导演回答。
- `film_file_read`、`film_file_write`：在当前画布隔离的 Agent Workspace 中读写相对路径文件。
- `film_memory_recall`：从当前隔离 Workspace 的影视任务记录中召回历史；没有记录时返回 `not_found`。
- `film_task_create`、`film_task_update`、`film_task_list`、`film_task_read`：管理当前隔离 Workspace 的影视任务清单。
- `film_asset_search` / `film_asset_save`：分别调用项目素材列举和素材同步执行器，使用真实节点 ID，不返回或复制存储 URL。

以下附件别名也已注册，但当前仓库没有对应的统一原生执行器，因此调用会返回明确能力错误，不会伪造成功：`film_scene_director`（旧 commands 协议）、`film_video_edit`、`film_audio_gen`、`film_sfx_gen`、`film_color_grade`。已有具体 TapCanvas 工具时，应直接使用其真实协议，例如 `tapcanvas_capture_director_scene`、`tapcanvas_render_director_clip`、`tapcanvas_material_assets_list`。

## 失败与交付

- 原生工具返回错误时保留错误码、诊断和工具调用事实，禁止改走公共 API 或静默降级。
- `queued` / `running` 只表示任务尚未结束；只有真实终态和资产 URL 才构成媒体交付证据。
- 当前画布操作完成后，回答实际写入的节点、任务状态和资产事实。
