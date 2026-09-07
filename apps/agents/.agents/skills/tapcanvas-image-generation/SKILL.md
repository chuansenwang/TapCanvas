---
name: tapcanvas-image-generation
description: 在用户要求生成或编辑图片时，直接使用 TapCanvas 原生 film_image_gen 函数并把真实结果写入当前画布；不使用外部 MCP、shell 或手工 API 探查。
---

# TapCanvas 原生生图

当用户要求生成图片、角色锚点、场景参考、道具图或基于已有参考图编辑时，直接调用 `film_image_gen`。这是 Agent 内置函数，不是 MCP 工具，也不需要先调用画布读取、模型目录查询或 shell 命令。

## 参数

- `prompt` 必填，填写可直接交给图片模型的完整提示词。
- `title`、`tag`、`aspect_ratio`、`ai_model`、`quality_spec` 和 `model_confirmation` 按用户明确要求传入；不确定时省略，让后端按当前账号和项目目录解析。
- 无参考图时省略 `reference_nodes` 和 `reference_assets`，或使用 `mode_type: "text2image"`。
- 需要参考图时只传当前画布真实节点 ID 或已授权资产 ID，并使用 `mode_type: "image2image"`；禁止复制或猜测 URL。
- `prompt_template` 只在用户明确提供模板时传入，不要把旧脚本中的固定模板当作默认值。

## 结果与失败

函数返回真实的 `nodeId`、`flowId`、`taskId`、状态和资产信息。`running` 只表示任务已受理并已写入画布，不能宣称图片已经完成；只有返回 `success` 且存在真实资产 URL 时才报告已生成。

缺少当前画布作用域、用户身份、可用执行配置或后端回执时，原地报告具体错误。不要改走 MCP、shell、外部 API、默认模型或伪造图片结果。
