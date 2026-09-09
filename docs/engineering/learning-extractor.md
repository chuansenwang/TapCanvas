# AI 错误经验登记流水

本文件记录已确认的单次 AI 错误事件。每次事件使用三个 bullet：`背景`、`现象与根因`、`处置与预防`。同类事件升级为长期经验后，保留原始记录并关联 `HE-FL-XXX`。

- **背景**：此前为 MiniMax H3 接入本地 ComfyUI 视频生成时，需要登记可执行模型目录与工作流变体。
- **现象与根因**：错误地将 H3 理解为固定的单一 I2VA 工作流，只登记了一个粗粒度视频变体，无法表达 T2VA、I2VA、L2VA、FL2VA、Ref2VA 和显式数字人输入。根因是没有先核对本地 `MiniMaxH3Easy` 节点的 `mode`、`keyframe_role` 与 `media_state` 输入合同。
- **处置与预防**：已改为同一真实节点图下的六个显式输入合同，并在选择、上传、节点写入和测试层校验媒体角色；以后登记视频模型前必须先读取并验证本地工作流节点信息，未知模式不得猜测或静默降级。

- **背景**：用户使用已登记的 MiniMax H3 ComfyUI 模型提交 10 秒全参考视频。
- **现象与根因**：模型目录曾把 `durationOptions` 错登记为 `[4]`，并且 H3 全参考媒体同时被送入传统 `LoadImage` 节点数量校验，导致合法时长被拒、参考图节点数与输入不一致。根因是把 H3 的 `MiniMaxH3EasyMediaLoader.media_state` 与旧式图片节点合同混为一谈。
- **处置与预防**：目录现声明 1–15 秒并保留默认 4 秒；H3 变体跳过传统图片节点数量校验，统一通过 `media_state` 传递多媒体；首尾帧与普通参考素材仍保持互斥，提交时必须明确二选一模式。

- **背景**：H3 全参考重试已通过模型、时长和输入模式校验，但 ComfyUI `/prompt` 返回 400。
- **现象与根因**：提交工作流中的 `resolution="720p"`、二阶段 `unet_name="minimax_h3_fl2va_pruned_w4a8_mixed.safetensors"` 和 `tiny_vae="taeh3.safetensors"` 均不在本机 ComfyUI 的实时枚举中。根因是登记工作流时沿用了与本机节点不同的大小写和模型文件名，且没有在提交前用 `/object_info` 实际枚举校验。
- **处置与预防**：已按本机校验错误改为大写分辨率枚举（`720P` 等）、已安装的 `minimax_h3_fl2va_pruned_int8_convrot.safetensors` 以及 `tiny_vae="none"`，并在 API 工作流边界把小写分辨率规范化为大写；后续工作流登记必须以本机节点实时枚举为准。

- **背景**：用户反馈 MiniMax H3 文生视频调用很快显示 `fetch failed`，此前曾把旧 Agents Bridge 的 30 分钟配置解释为当前原生 DSH Web 会话配置。
- **现象与根因**：当前原生 DSH Web 使用独立的 profile；更直接的根因是 H3 的 `runComfyUiTask()` 在拿到 ComfyUI `prompt_id` 后仍同步轮询 `/history`，直到视频完成才返回 taskId，长连接断开时调用方只能看到 `fetch failed`，而 ComfyUI 任务仍在运行。
- **处置与预防**：将 H3 视频改为提交 ComfyUI 后立即返回 `running + promptId`，通过统一任务轮询和画布 reconcile 收取终态；区分 `COMFYUI_POLL_TIMEOUT_MS`（后端轮询预算）与原生 Agent/浏览器连接生命周期，今后不得把旧 Bridge 配置当作原生 DSH 配置的证据。
