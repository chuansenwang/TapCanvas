---
name: tapcanvas-film-functions
description: 使用 TapCanvas 原生影视 Function 完成图片、视频、拼接、导演提问、文件和任务操作；不使用外部 MCP 或手工 API 探查。
---

# TapCanvas 影视 Function

## 直接执行

当用户已经明确提出影视制作动作时，直接调用对应原生 Function，不先探查 MCP、端口、token、模型列表或外部脚本。Function 会读取当前画布作用域，并把可执行结果写入当前画布或隔离 Workspace。

- `film_image_gen`：文生图或参考节点/资产图生图，写入图片节点。每次调用都必须显式传 `vendor`：本地 ComfyUI 模型传 `vendor: "comfyui"`，系统模型传 `vendor: "newapi"`；不能省略，也不能仅凭模型名推断。
- 一次图片请求只调用一次 `film_image_gen`。执行器返回失败后，原地报告真实错误并停止；不要自动改用另一个 vendor、换模型或重复提交同一生成任务。
- `film_video_gen`：文生视频或参考图生视频，写入视频节点并返回异步任务回执。多段续写需显式传 `continuation_from_node` 和 `continuation_mode`；执行器会从真实上游视频抽取尾帧资产，按 `first_frame` 或 `reference` 角色传递，不能把首尾帧与普通参考混用。
- 相邻视频不自动连续：场景/时间/上下文改变时使用独立的 `editorial_cut` 语义，不传 `continuation_from_node`；只有同一动作需要接力时才显式传入连续性字段。
- `film_video_composite`：按视频节点 ID 拼接已生成片段。
- `film_ask_human`：需要导演确认或补充信息时等待用户回答。
- `film_file_read` / `film_file_write`：读写当前画布隔离 Workspace 的相对路径文件。
- `film_memory_recall`：召回当前隔离 Workspace 的影视任务记录。
- `film_task_create` / `film_task_update` / `film_task_list` / `film_task_read`：管理影视任务状态。
- `film_asset_search` / `film_asset_save`：检索或同步当前项目素材库中的真实节点资产。

## 结果判定

- `film_image_gen` 和 `film_video_gen` 返回 `running` 只代表任务已受理并已落画布，不能说媒体已经完成。
- 只有真实终态和真实资产字段构成已生成证据；失败时保留错误信息并原地报告。
- 参考图只传当前画布真实节点 ID 或授权资产 ID，不复制 URL。
- 缺少当前画布作用域、用户身份、执行配置或前置真实资产时显式失败，不猜测或自动降级。
- 本地模型不能只凭模型名称推断执行器；必须同时确认模型目录中的 `vendor` 和 `modelKey`，并将 `vendor: "comfyui"` 与精确 `ai_model` 一起传给 `film_image_gen`。

## 能力边界

以下附件函数名称已注册以保持契约可发现，但当前仓库没有统一的真实执行器，调用会明确报错：`film_scene_director`（旧 commands 协议）、`film_video_edit`、`film_audio_gen`、`film_sfx_gen`、`film_color_grade`。存在具体 TapCanvas 工具时使用具体协议，例如 `tapcanvas_capture_director_scene`、`tapcanvas_render_director_clip`、`tapcanvas_material_assets_list`。

不要把“函数已注册”当作“业务已完成”；对上述能力必须如实报告缺口，等待对应执行器接入后再重试。
