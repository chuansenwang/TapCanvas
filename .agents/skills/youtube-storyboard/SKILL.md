---
name: youtube-storyboard
description: 从视频提取可验证的影视分镜。用户提供 YouTube URL 或本地视频文件并要求分镜拆解、镜头表、shot list、镜头时间码、视频复盘或 storyboard 时必须使用；链接走 video-downloader 下载，本地视频文件直接抽帧，用 ffmpeg 全帧率场景检测切出真实镜头边界与时间码，需要声音/对白证据时用 subtitle-transcribe 识别字幕。镜头切分完全由脚本完成，不做模型复核与镜头合并。无法访问或无法验证画面时必须显式失败，不得凭标题、字幕或常识臆测镜头。
---

# YouTube Storyboard

## Mission

把一个可访问的视频转换成可复核的分镜资料。输入可以是 YouTube 链接，也可以已经是本地视频文件；分镜是对原视频的观察记录，不是把视频改写成创作脚本；每一条记录都必须能回到原视频的时间区间。

镜头边界由 ffmpeg 场景检测脚本确定性地产出：在全帧率上逐帧比较相邻帧差异，超过阈值即为一次剪切。每个镜头的起止时间码是脚本算出的真实边界，不是模型估计；模型只负责描述画面上发生了什么，不负责决定在哪里切。字幕是识别出来什么就是什么，不合并、不改写。

## Required inputs

- 二选一：
  - 一个完整的 `http://` 或 `https://` YouTube URL（支持 `youtube.com/watch`, `youtu.be`, `youtube.com/shorts` 等标准形式）；
  - 一个本地视频文件路径（`mp4|webm|mov|m4v|mkv`），例如用户说“视频在这里/我已经下好了/用这个文件”。
- 拿到本地视频文件时直接抽帧，不再下载：下载是链接输入才需要的步骤，对已存在的本地文件重复下载既浪费又可能拿到与用户所指不同的版本。
- 可选：输出语言、是否包含对白/字幕/音效、是否需要 Markdown/JSON/CSV。
- 镜头粒度由脚本的切点决定，不做“段落级合并”：每个检测到的镜头就是一条记录。不按场景或叙事单元把多个镜头合并成一条，也不为凑整而拆分或补写。
- 时间码来自脚本的切点计算，是真实镜头边界（秒级三位小数），不是近似估计。

## Hard boundaries

1. 输入是链接时，先加载并复用 `video-downloader` skill，调用 `.agents/skills/video-downloader/scripts/download_video.py` 下载本地 MP4；输入已经是本地视频文件时跳过下载，直接进入镜头检测。镜头切分一律由 `prepare-youtube.mjs` 的 scene 模式完成：用 `D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe` 在原始帧率上跑场景检测拿到真实切点，再按切点计算镜头区间并逐镜头抽代表帧。
2. 场景检测必须在原始帧率上进行。先把视频降到低帧率（如 `fps=1`）再检测会把普通的帧间运动放大成“场景切换”，实测同一视频同一阈值下切点会从 17 个虚增到 237 个，产出的不是镜头而是噪声。检测与抽帧的顺序同样是先检测、后抽帧。
3. 对白、旁白、讲话人这类声音证据只能来自 `subtitle-transcribe` skill：先复用它是唯一允许的字幕识别实现，不要在分镜流程里临时拼 Whisper 命令或读第三方字幕接口。默认 `auto`（链接输入时 YouTube 人工字幕优先，缺失则本地 Whisper 识别；本地视频文件输入直接走本地 Whisper 识别）；用户明确要求“用原视频字幕”用 `youtube`（仅链接输入可用），要求“本地识别”用 `whisper`。字幕识别结果原样进入交付，不合并相邻片段、不改写文本。
4. 只把真实视频、可验证字幕和接口返回的理解结果作为事实来源。标题、简介、评论、缩略图只用于元数据，不能替代画面证据。
5. 链接输入遇到受限、删除、年龄限制、地区不可用、登录墙、DRM 或 `yt-dlp` 无法解析时原地失败，并报告具体命令/HTTP 错误；本地视频文件输入遇到不可解码、路径不存在或时长探测失败时同样原地失败。两种情况都不要换成搜索结果、相似视频、默认样片或“根据标题推测”。
6. 只为分镜分析下载链接输入的视频，不把视频文件重新分发给第三方。本地视频文件输入不产生新的视频副本；输出中不得泄露 API key、Cookie 或签名凭据。
7. 不对切点结果做模型复核：不为了让结果“更整齐”而用模型判断该不该合并相邻镜头，也不做视觉质检门禁。切点由脚本产出后直接进入交付。
8. 长视频必须按真实时间范围分块描述。分块是读取成本约束，不能改变脚本给出的镜头边界；禁止为了凑数量捏造条目。
9. 可变帧率（VFR）视频必须显式失败：脚本按帧号定位代表帧，VFR 下帧号与时间不对应会导致代表帧落到错误的镜头里。失败时提示用户先用 ffmpeg 转成恒定帧率。

## Workflow

### 1. Normalize and inspect

下载由 `video-downloader` 负责，仅链接输入需要；本地视频文件输入跳过下载直接抽帧。两条路径共用同一个脚本，帧提取可用 `FFMPEG_PATH` 覆盖。

链接输入：
```bash
# 不需要对白/字幕时去掉 --subtitles
node .agents/skills/youtube-storyboard/scripts/prepare-youtube.mjs \
  --url "<youtube-url>" \
  --subtitles auto \
  --format json
```

本地视频文件输入（不下载、不联网）：

```bash
node .agents/skills/youtube-storyboard/scripts/prepare-youtube.mjs \
  --media "<本地视频路径>" \
  --subtitles whisper \
  --format json
```

本地视频旁有同名 `.info.json` 时脚本自动取用，也可用 `--metadata "<info.json>"` 显式指定；没有元数据也能运行，脚本会用 `ffprobe`（可用 `FFPROBE_PATH` 覆盖）读出真实时长，读不到时长即显式失败。目录里存在别的视频的 `.info.json` 时按同名匹配，不会把别人的标题/时长套在当前视频上。本地输入没有 YouTube 现成字幕可用，`--subtitles auto` 与 `--subtitles whisper` 都走本地 Whisper；`youtube` 只对链接输入有效。

检查返回的 `source.shots`、`source.frameExtraction`、`source.candidateFrames`、`source.contactSheets`、`source.durationSec`；链接输入还要检查 `source.url` 与 `directVideoUrl`。若切片、代表帧、本地视频路径或时长任一缺失，停止并显式说明缺口。本地视频输入的 `directVideoUrl` 为 `null`，这是正常事实，不构成失败，也不能伪造一个直链。

产物按 `<模式>-<参数>-<源文件指纹>` 命名，因此换阈值、换视频都不会覆盖或混用旧结果，也不需要删除已有产物。

### 2. Shot boundaries come from the script

`--frame-mode scene`（默认）的产出事实：

- `source.shots[]`：每个镜头一条，含 `shotIndex`、`startSec`、`endSec`、`durationSec`、`sampleTimeSec`、`frameNumber`、`framePath`、`cutScore`。首镜头从 `0` 开始，末镜头结束于媒体真实时长，区间首尾相接、无缺口。
- `source.frameExtraction`：记录本次检测参数与结果统计——`sceneThreshold`、`minCutGapSec`、`frameRate`、`rawCutCount`（原始切点）、`cutCount`（去重后切点）、`shotCount`、`reused`、`boundariesFile`。
- `shot-boundaries-<参数>-<指纹>.json`：镜头边界单独落盘，交付后复核时间码不必重跑整片解码。

切点去重只做一件事：合并同一处爆发的连续切点。ffmpeg 逐帧检测会把一次真实切换连报两帧（实测间隔 0.033 秒），不去重会得到两条零时长镜头。去重阈值默认 `--min-cut-gap 0.1` 秒，这是同一个切点的重复上报，不是镜头合并。除此之外不合并任何相邻镜头。

阈值默认 `--scene-threshold 0.25`。依据两个真实视频的全帧率评分实测：`0.3` 会漏掉插入镜头与运镜切换（28 分 20 秒样本只剩 17 个镜头），`0.2` 会把画面内运动计入（同一视频涨到 56 个）。`0.25` 下两个样本分别得到 30 / 62 个镜头，经画面复核多出的切点均为真实剪辑。用户明确要求更粗或更细时可显式调整该参数，但不要用模型判断替代阈值。

`--frame-mode interval` 是另一条独立路径：按固定间隔（默认 `--frame-interval 15`）均匀抽样的候选帧，只作画面证据点，`source.shots` 为 `null`。它不做切点判定，也不参与镜头边界。

`contactSheets` 把代表帧按 5×4 拼成 contact sheet，用于一次读取多帧画面证据。每张拼图都带 `frameNumbers`（该图真实包含的帧号）与 `paddingCells`（末尾由 ffmpeg 重复填充的格数），读取时不得把填充格当作额外证据点。

加 `--subtitles auto|youtube|whisper` 时，脚本会在同一目录下调用 `subtitle-transcribe` 并返回 `source.subtitles`：`sourceKind`、`captionKind`、`segmentCount`、`durationSec`、`report`、`artifacts` 与逐段 `segments`。字幕识别失败时脚本直接非零退出，不允许在分镜阶段静默继续。

`--media` 既可以指向用户自己提供的本地视频，也可以指向之前下载过的视频；两种情况都跳过重复下载。

### 3. Prepare subtitle evidence（需要声音/对白时）

`--subtitles` 是分镜流程读取字幕证据的唯一入口；也可以在准备好本地视频后单独调用该 skill：

```powershell
& F:\aigc\aigc\.venv\Scripts\python.exe .agents\skills\subtitle-transcribe\scripts\transcribe_subtitles.py `
  --media "<本地视频路径>" `
  --video-id "<videoId>" `
  --out-dir "<分镜输出目录>/subtitles" `
  --mode auto
```

逐段事实文件是 `subtitles/<videoId>_transcript_segments.json`。把其中的 `start`/`end`/`text`/`speaker` 按时间区间结构映射到分镜表的 `dialogue` 与 `audio` 字段：一个镜头区间内可能有零条或多条字幕，全部按原样并入，不合并相邻字幕片段、不润色文本、不改写标点。映射只做时间区间匹配，不做正文关键词判断。

用户没要求对白/字幕时可以不传 `--subtitles`，此时字幕证据记为 `not_requested`。用户要求但对白不可得时标 `unavailable` 并写明失败原因；不能把平台自动生成字幕写成原声逐字稿。本地视频文件没有 YouTube 现成字幕，`auto` 会走本地 Whisper；此时不要为了凑字幕去下载同内容的网络版本。不要在 `--mode auto` 失败后手工改走别的接口，先向用户暴露真实原因。

### 4. Describe each shot from its representative frame

镜头边界已由脚本确定，这一步只负责描述画面内容。按 `source.shots` 的顺序，依据每个镜头的 `framePath` 与 `contactSheets` 写出该镜头的画面主体、动作与镜头语言要点。

长视频可按真实时间范围分块读取以控制上下文成本，但分块只是读取约束，不是切分依据：镜头数量与边界一律以 `source.shots` 为准，不新增、不减少、不合并。

把块结果按 `shotIndex` 归回脚本给出的时间轴。保留分析模型、请求时间、视频 ID 和失败信息；不要覆盖已有分析文件。若同一镜头出现互相冲突的描述，保留两条并标记 `reviewRequired: true`，不得静默选择一条。

### 5. Self-review before delivery

逐条检查：

- 时间码与 `source.shots` 完全一致：单调递增、首条从 `0` 开始、末条结束于媒体时长，无负数、无反向区间、无缺口；
- 条目数量等于 `source.frameExtraction.shotCount`，没有为了“更整齐”而合并、新增或丢弃镜头；
- 每个镜头都有画面主体和至少一种镜头语言要点，未知内容明确写 `unknown`；
- 音频、对白、字幕只在有证据时填写；
- 有 `subtitles` 证据时，分镜表的 `dialogue` 能对应到具体字幕片段的时间区间；没有就写 `unknown`，不要用画面猜测台词；
- 没有把标题/简介中的语义冒充画面事实；
- 结果能由用户用播放器时间码复核；
- 失败、低置信度和冲突均暴露给用户。

## Delivery format

默认同时输出：

1. `storyboard.json`：遵循 `references/schema.md`，保存机器可读事实与 provenance。
2. `storyboard.md`：先给视频元数据和分析范围，再给分镜表，列出 `镜头号 | 时间范围 | 时长 | 画面概述 | 镜头语言要点 | 声音/对白 | 置信度 | 复核备注`。时间范围直接写脚本算出的镜头边界（如 `00:35.000–01:10.500`），用户可据此在播放器里定位复核。

如果用户只要一种格式，按用户指定交付，但仍保留 provenance、未知字段和失败诊断。不要输出“已生成分镜图”或“已写入画布”，除非确实调用了对应工具并取得真实结果；本 skill 默认只做视频理解和分镜文本交付。

## Failure reporting

失败消息必须包含：阶段（解析/媒体读取/视频理解/合并/校验）、真实错误摘要、受影响的输入（链接或本地视频路径）或时间区间、是否已有可交付的部分结果、用户可执行的下一步。不要用“网络问题”“模型异常”等笼统措辞替代原始证据。

## Anti-patterns

- 不用正则、关键词表或固定模板猜测镜头内容或类型；正则只允许做 URL/数值/类型/时间码格式校验。
- 不把脚本算出的切点交给模型复核，不为了“更整齐”而合并或拆分脚本给出的镜头。
- 不在原始帧率之外的地方做场景检测：先降帧再检测会把运动误判成切换，产出的是噪声不是镜头。
- 不用模型判断替代阈值：调粒度就调 `--scene-threshold`，不要让模型决定哪里该切。
- 不把 `interval` 模式的固定抽样间隔当作镜头边界；那条路径只产出画面证据点，不产出切点。
- 不合并字幕识别结果，不润色或改写识别文本，识别出来什么就是什么。
- 不为了满足“至少 N 条记录”而拆分或补写；也不为了“看起来更完整”而丢弃短镜头。
- 不把生成式 AI 的创作建议混入原视频事实；如用户要再创作，另起任务并明确标注为建议。
- 不在接口失败时回退到视频标题、缩略图、搜索摘要或旧分析结果。
- 不对用户已提供的本地视频文件重复下载，也不擅自把本地文件替换成网络版本。
- 不在本 skill 中重新实现下载器；下载问题统一依据 `video-downloader` 的 `download-report.json` 报告定位。

## References

- 需要精确字段和示例时读取 `references/schema.md`。
- 需要准备输入（YouTube 链接或本地视频）时执行 `scripts/prepare-youtube.mjs --help`。
- 字幕识别的能力、产物与失败契约见 `.agents/skills/subtitle-transcribe/SKILL.md`。
