---
name: youtube-storyboard
description: 从 YouTube/油管视频链接提取可验证的影视分镜。用户提供 YouTube URL 并要求分镜拆解、镜头表、shot list、镜头时间码、视频复盘或 storyboard 时必须使用；先解析视频事实，再通过 TapCanvas 视频理解接口按镜头边界输出结构化 JSON 与可读 Markdown。无法访问、无法取得媒体直链或无法验证画面时必须显式失败，不得凭标题、字幕或常识臆测镜头。
---

# YouTube Storyboard

## Mission

把一个可访问的 YouTube 视频转换成可复核的镜头级分镜资料。分镜是对原视频的观察记录，不是把视频改写成创作脚本；每一条镜头都必须能回到原视频的时间区间。

## Required inputs

- 一个完整的 `http://` 或 `https://` YouTube URL（支持 `youtube.com/watch`, `youtu.be`, `youtube.com/shorts` 等标准形式）。
- 可选：输出语言、目标粒度（粗粒度/标准/细粒度）、是否包含对白/字幕/音效、是否需要 Markdown/JSON/CSV。
- 未指定粒度时采用标准粒度：以画面主体、景别、机位或动作发生实质变化作为切点；不要按固定秒数机械切分。

## Hard boundaries

1. 先加载并复用 `tapcanvas-video-downloader` skill，调用它的 `scripts/download_video.py`（默认发现 `D:\soft\yt-dlp.exe`）下载本地 MP4；再用 `D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe` 做场景变化检测、抽取候选帧。YouTube 页面地址不能直接当作 `videoUrl` 传给视频理解接口。
2. 所有 TapCanvas `/public/*` 调用必须先加载 `tapcanvas-api` skill，并通过它的 `scripts/call.mjs --endpoint videoUnderstand` 执行。不要自行拼接 HTTP 请求、猜测 API key 或改用平行接口。
3. 只把真实视频、可验证字幕和接口返回的理解结果作为事实来源。标题、简介、评论、缩略图只用于元数据，不能替代画面证据。
4. 受限、删除、年龄限制、地区不可用、登录墙、DRM 或 `yt-dlp` 无法解析时原地失败，并报告具体命令/HTTP 错误；不要换成搜索结果、相似视频、默认样片或“根据标题推测”。
5. 不下载或重新分发视频文件，除非用户明确授权且当前环境允许。优先使用短时有效的直链并在完成后丢弃临时文件；输出中不得泄露 API key、Cookie 或签名凭据。
6. 长视频必须按真实时间范围分块分析。块之间保留至少一个可验证的重叠窗口，并在合并时去重；禁止为了凑数量捏造镜头。

## Workflow

### 1. Normalize and inspect

运行（下载由 `tapcanvas-video-downloader` 负责；帧提取可用 `FFMPEG_PATH` 覆盖）：

```bash
node apps/agents-cli/skills/tapcanvas-youtube-storyboard/scripts/prepare-youtube.mjs \
  --url "<youtube-url>" \
  --format json
```

检查返回的 `source.url`, `videoId`, `title`, `durationSec`, `directVideoUrl`, `localVideoPath`, `candidateFrames`。若下载、候选帧抽取、直链或时长任一缺失，停止并显式说明缺口。

如果用户要求对白/字幕，额外尝试读取公开字幕；字幕缺失不是画面分析失败，但必须在输出中标记 `subtitleEvidence: unavailable`，不能把自动生成的字幕当作原声逐字稿。

### 2. Choose analysis chunks

- 小于等于 10 分钟：一次 `videoUnderstand`。
- 超过 10 分钟：按真实时码切成不超过 8 分钟的区间，区间边界写入请求 prompt；相邻区间保留 2 秒重叠。
- 仅按时长分块是传输约束，不是镜头切点。模型仍需在每个块内识别真实 cut、动作/构图/场景变化。

### 3. Request structured understanding

对每个块调用 `videoUnderstand`，prompt 必须要求：

- 只输出 JSON，不要 Markdown 围栏、说明前缀或工具痕迹；
- 返回 `shots[]`，每个镜头包含 `shotId`, `startSec`, `endSec`, `shotType`, `camera`, `visual`, `action`, `audio`, `dialogue`, `transition`, `confidence`；
- `startSec/endSec` 使用相对视频起点的秒数，`0 <= startSec < endSec <= chunkEndSec`；
- 明确记录看不清、无法辨识或仅由字幕推断的字段为 `unknown`，并降低 `confidence`；
- 不把连续动作拆成无意义的逐帧记录，也不把同一镜头内的推拉摇移误报成剪切。
- 将 `candidateFrames` 作为切点审查证据；它们是 ffmpeg 的候选切点，不是最终镜头列表。最终边界必须由视频内容理解确认。

### 4. Merge and preserve evidence

把块结果换算到全片时间轴，按时间排序并合并重叠区间的重复镜头。保留原始块结果摘要、分析模型、请求时间、视频 ID 和失败信息；不要覆盖已有分析文件。若同一时间段存在冲突，保留两条记录并标记 `reviewRequired: true`，不得静默选择一条。

### 5. Self-review before delivery

逐条检查：

- 时间码连续、边界合法且没有负数/反向区间；
- 每个镜头都有画面主体和至少一种镜头语言，未知内容明确写 `unknown`；
- 音频、对白、字幕只在有证据时填写；
- 没有把标题/简介中的语义冒充画面事实；
- 结果能由用户用播放器时间码复核；
- 失败、低置信度和冲突均暴露给用户。

## Delivery format

默认同时输出：

1. `storyboard.json`：遵循 `references/schema.md`，保存机器可读事实与 provenance。
2. `storyboard.md`：先给视频元数据和分析范围，再给镜头表，列出 `镜头号 | 起止时间 | 时长 | 景别/机位 | 画面与动作 | 声音/对白 | 转场 | 置信度 | 复核备注`。

如果用户只要一种格式，按用户指定交付，但仍保留 provenance、未知字段和失败诊断。不要输出“已生成分镜图”或“已写入画布”，除非确实调用了对应工具并取得真实结果；本 skill 默认只做视频理解和分镜文本交付。

## Failure reporting

失败消息必须包含：阶段（解析/媒体读取/视频理解/合并/校验）、真实错误摘要、受影响的 URL 或时间区间、是否已有可交付的部分结果、用户可执行的下一步。不要用“网络问题”“模型异常”等笼统措辞替代原始证据。

## Anti-patterns

- 不用正则、关键词表或固定模板猜测镜头内容、类型或切点；正则只允许做 URL/数值/类型校验。
- 不把每 3 秒或每 5 秒当作镜头边界；ffmpeg 的 `sceneThreshold=0.3` 只用于候选帧发现。
- 不为了满足“至少 N 个镜头”而拆分或补写。
- 不把生成式 AI 的创作建议混入原视频事实；如用户要再创作，另起任务并明确标注为建议。
- 不在接口失败时回退到视频标题、缩略图、搜索摘要或旧分析结果。
- 不在本 skill 中重新实现下载器；下载问题统一依据 `tapcanvas-video-downloader` 的 `download-report.json` 报告定位。

## References

- 需要精确字段和示例时读取 `references/schema.md`。
- 需要准备 YouTube 输入时执行 `scripts/prepare-youtube.mjs --help`。
