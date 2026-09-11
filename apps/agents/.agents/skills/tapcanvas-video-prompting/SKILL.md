---
name: tapcanvas-video-prompting
description: 处理关键帧转视频、短视频规划、节奏控制与拆段判断；输出最小可执行的视频提示词结果，不把 SOP 固化进后端 prompt。
---

# TapCanvas Video Prompting

## 何时使用

- 用户要从关键帧、分镜或章节正文生成短视频
- 用户只要视频提示词，或要把视频节点落到画布
- 主代理需要判断是否应该拆段、是否需要节奏审查

## 输入证据

- 选中节点、关键帧、参考图、章节正文、连续性与素材工具结果
- 已验证的角色、环境、动作、对白、时长与禁止项

## 执行原则

- 先确认事实，再组织 video prompt
- 是否先补关键帧、是否直接进视频、是否拆段，属于主代理基于证据的判断
- 长度、节奏、转场密度属于方法论，不属于后端硬编码
- 若需要专门提示词产出，可按需调用 `video_prompt_specialist`
- 若需要感知节奏审查，可按需调用 `pacing_reviewer`
- 若缺关键事实，显式说明缺口，不要用模板句硬填

## 输出契约

- 若输出视频提示词，最小结果应包含：
  - `prompt`
- 若需要保留拍点拆解，可附带 `storyBeatPlan`，但真实生成只消费 `prompt`
- 若需要拆段建议，应明确指出拆分原因与建议边界
- 若证据不足，返回缺失事实，而不是伪造完整 prompt

## MiniMax H3 执行格式

当 `ai_model` 为 `minimax-h3` 时，最终 `prompt` 必须直接使用 H3 的结构化字段，不能只提交中文剧情段落：

- 文生视频或首尾帧模式：`integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music`。
- 全参考模式：按顺序使用 `subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music`。
- 关键帧模式必须在第一行写清图片与 `0.00s` 或最终秒点的对齐关系；全参考模式必须用稳定的 `<Subject N>` / `<Picture N>` 标签，并区分角色外观、场景构图和风格职责。
- 每个镜头都写可执行的时间轴、进入态、空间位置、动作结果、退出态和镜头运动。只写“承接上一段”不构成连续性证据。

多段视频需要显式调用 `film_video_gen` 的 `continuation_from_node` 与 `continuation_mode`：`first_frame` 将上一段真实视频尾帧作为本段首帧，`reference` 将尾帧作为全参考素材。两者必须二选一；H3 不允许首尾帧与普通参考素材混用。

## 镜间连续性决策

相邻视频不默认连续，必须按每个剪辑缝的真实叙事关系选择：

- `editorial_cut`：场景、时间、地点、视角或上下文发生变化；不引用上一段尾帧，也不引用上一段视频本体。使用新的场景/角色参考图，并在提示词中明确切换后的进入态。
- `bridge_frames`：两个片段属于同一动作或同一空间，但需要在独立视频之间共享一个预先设计的桥接静帧；上一段尾帧和下一段首帧必须是同一真实图片资产。
- `reference_video`：只有确实要沿着上一段视频的运动、镜头和时间状态继续时才使用；必须存在真实上一段视频，且不能同时声明时间跳跃。

场景切换、叙事跳时、上下文改变时应使用 `editorial_cut`，即使角色相同也不能因为节点相邻而强行接尾帧。H3 的 `continuation_from_node` 只在主代理明确裁决为首帧承接或尾帧全参考时传入；没有该字段就保持独立镜头。
