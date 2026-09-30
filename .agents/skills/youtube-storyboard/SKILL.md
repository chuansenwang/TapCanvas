---
name: youtube-storyboard
description: 从视频提取可验证的镜头切点。用户提供 YouTube URL 或本地视频文件并要求分镜拆解、镜头表、shot list、镜头时间码、视频复盘或 storyboard 时必须使用；默认交付镜头边界、时间码与「声音/对白」列的字幕证据（源视频含对白时默认走 subtitle-transcribe 识别），逐张读图描述画面仅在用户明确要求时执行。链接走 video-downloader 下载，本地视频文件直接抽帧，用 ffmpeg 全帧率场景检测切出真实镜头边界与时间码。镜头切分完全由脚本完成，不做模型复核与镜头合并。无法访问或无法读取视频时必须显式失败，不得凭标题、字幕或常识臆测镜头。
---

# YouTube Storyboard

## Mission

把一个可访问的视频转换成可复核的镜头切点资料。输入可以是 YouTube 链接，也可以已经是本地视频文件；分镜是对原视频的观察记录，不是把视频改写成创作脚本；每一条记录都必须能回到原视频的时间区间。

默认交付 = 镜头边界 + 时间码（+ 可选字幕对齐）。镜头边界由 ffmpeg 场景检测脚本确定性地产出：在全帧率上逐帧比较相邻帧差异，超过阈值即为一次剪切。每个镜头的起止时间码是脚本算出的真实边界，不是模型估计。

模型默认不读取任何画面：脚本会照常抽出每个镜头的代表帧并拼成 contact sheet，产物落盘供用户复核，但除用户明确要求描述画面外，不需要逐张读图。字幕是识别出来什么就是什么，不合并、不改写。

## Required inputs

- 二选一：
  - 一个完整的 `http://` 或 `https://` YouTube URL（支持 `youtube.com/watch`, `youtu.be`, `youtube.com/shorts` 等标准形式）；
  - 一个本地视频文件路径（`mp4|webm|mov|m4v|mkv`），例如用户说“视频在这里/我已经下好了/用这个文件”。
- 拿到本地视频文件时直接抽帧，不再下载：下载是链接输入才需要的步骤，对已存在的本地文件重复下载既浪费又可能拿到与用户所指不同的版本。
- 可选：输出语言、是否包含对白/字幕/音效、是否需要 Markdown/JSON/CSV。
- 镜头粒度由脚本的切点决定，不做“段落级合并”：每个检测到的镜头就是一条记录。不按场景或叙事单元把多个镜头合并成一条，也不为凑整而拆分或补写。
- 时间码来自脚本的切点计算，是真实镜头边界（秒级三位小数），不是近似估计。
- 画面描述（主体、动作、景别、镜头语言）只有在用户明确要求时才是交付项；默认不产出，也不因此算作失败。

## Hard boundaries

1. 输入是链接时，先加载并复用 `video-downloader` skill，调用 `.agents/skills/video-downloader/scripts/download_video.py` 下载本地 MP4；输入已经是本地视频文件时跳过下载，直接进入镜头检测。镜头切分一律由 `prepare-youtube.mjs` 的 scene 模式完成：用 `D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe` 在原始帧率上跑场景检测拿到真实切点，再按切点计算镜头区间并逐镜头抽代表帧。
2. 一个视频一个分镜目录：产物必须收在当前视频的专属目录里，不得与视频文件或其它视频的产物平铺混放。本地视频输入的目录是 `<视频所在目录>/<视频文件名>.storyboard/`；链接输入复用 `video-downloader` 生成的下载目录（本身已是一次下载一个目录）。需要换位置时用 `--out-dir` 显式指定，不在目录之间搬运或混放产物。历史遗留的平铺产物不自动迁移，也不参与本次复用判定。
3. 场景检测必须在原始帧率上进行。先把视频降到低帧率（如 `fps=1`）再检测会把普通的帧间运动放大成“场景切换”，实测同一视频同一阈值下切点会从 17 个虚增到 237 个，产出的不是镜头而是噪声。检测与抽帧的顺序同样是先检测、后抽帧。
4. 对白、旁白、讲话人这类声音证据只能来自 `subtitle-transcribe` skill：先复用它是唯一允许的字幕识别实现，不要在分镜流程里临时拼 Whisper 命令或读第三方字幕接口。除用户明确说“不要对白/只要时间码”、或源视频确认没有人声（纯音乐、纯环境音）外，默认必须取得字幕证据，不得省略；只有这两种情况才允许把字幕证据记为 `not_requested`。默认 `auto`（链接输入时 YouTube 人工字幕优先，缺失则本地 Whisper 识别；本地视频文件输入直接走本地 Whisper 识别）；用户明确要求“用原视频字幕”用 `youtube`（仅链接输入可用），要求“本地识别”用 `whisper`。字幕识别结果原样进入交付，不合并相邻片段、不改写文本。
5. 只把真实视频、可验证字幕和接口返回的理解结果作为事实来源。标题、简介、评论、缩略图只用于元数据，不能替代画面证据。
6. 链接输入遇到受限、删除、年龄限制、地区不可用、登录墙、DRM 或 `yt-dlp` 无法解析时原地失败，并报告具体命令/HTTP 错误；本地视频文件输入遇到不可解码、路径不存在或时长探测失败时同样原地失败。两种情况都不要换成搜索结果、相似视频、默认样片或“根据标题推测”。
7. 只为分镜分析下载链接输入的视频，不把视频文件重新分发给第三方。本地视频文件输入不产生新的视频副本；输出中不得泄露 API key、Cookie 或签名凭据。
8. 不对切点结果做模型复核：不为了让结果“更整齐”而用模型判断该不该合并相邻镜头，也不做视觉质检门禁。切点由脚本产出后直接进入交付。
9. 进入画面描述步骤后，长视频必须按真实时间范围分块读取。分块是读取成本约束，不能改变脚本给出的镜头边界；禁止为了凑数量捏造条目。
10. 可变帧率（VFR）视频必须显式失败：脚本按帧号定位代表帧，VFR 下帧号与时间不对应会导致代表帧落到错误的镜头里。失败时提示用户先用 ffmpeg 转成恒定帧率。
11. 默认不读图。`source.shots[].framePath` 与 `source.contactSheets` 是落盘产物，交给用户复核或后续按需再读；逐张读取并写出画面描述只在用户明确要求时进行，不得在没有要求时自行开始读图。

## Workflow

### 1. Normalize and inspect

下载由 `video-downloader` 负责，仅链接输入需要；本地视频文件输入跳过下载直接抽帧。两条路径共用同一个脚本，帧提取可用 `FFMPEG_PATH` 覆盖。

链接输入：
```bash
# 字幕证据是默认交付的一部分；只有用户明确说“不要对白/只要时间码”时才去掉 --subtitles
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

为什么单独建目录：用户直接把视频放进资源管理器（例如 `E:\视频下载\`）时，`candidate-frames-*`、`candidate-sheets-*`、`subtitle`、`shot-boundaries-*` 这些产物会和一堆视频文件平铺在一起，视频一多就分不清哪批属于哪个视频。因此本地视频输入默认落在 `<视频所在目录>/<视频文件名>.storyboard/`，例如 `E:\视频下载\Emma.mp4` 对应 `E:\视频下载\Emma.storyboard\`。同一目录下有多个视频时，每个视频各自一个 `.storyboard` 目录，帧、拼图、切点、镜头边界与字幕都在自己的目录内；视频文件本身是唯一不在其中的东西，`.info.json` 仍与视频同名同目录、由脚本按同名匹配。需要自定义位置时加 `--out-dir "<分镜产物目录>"`，该目录只属于当前这一个视频，不要把多个视频的产物指向同一个目录。

本地视频旁有同名 `.info.json` 时脚本自动取用，也可用 `--metadata "<info.json>"` 显式指定；没有元数据也能运行，脚本会用 `ffprobe`（可用 `FFPROBE_PATH` 覆盖）读出真实时长，读不到时长即显式失败。目录里存在别的视频的 `.info.json` 时按同名匹配，不会把别人的标题/时长套在当前视频上。本地输入没有 YouTube 现成字幕可用，`--subtitles auto` 与 `--subtitles whisper` 都走本地 Whisper；`youtube` 只对链接输入有效。

检查返回的 `source.shots`、`source.frameExtraction`、`source.candidateFrames`、`source.contactSheets`、`source.durationSec`、`source.storyboardDir`；链接输入还要检查 `source.url` 与 `directVideoUrl`。若切片、代表帧、本地视频路径、产物目录或时长任一缺失，停止并显式说明缺口。本地视频输入的 `directVideoUrl` 为 `null`，这是正常事实，不构成失败，也不能伪造一个直链。

`source.candidateFrames` 与 `source.contactSheets` 非空即说明代表帧与拼图已落盘，默认流程到此为止；只有用户要求画面描述时才进入第 4 步读取。

分镜目录内的产物按 `<模式>-<参数>-<源文件指纹>` 命名，因此换阈值、换视频都不会覆盖或混用旧结果，也不需要删除已有产物。

### 2. Shot boundaries come from the script

`--frame-mode scene`（默认）的产出事实：

- `source.shots[]`：每个镜头一条，含 `shotIndex`、`startSec`、`endSec`、`durationSec`、`sampleTimeSec`、`frameNumber`、`framePath`、`cutScore`。首镜头从 `0` 开始，末镜头结束于媒体真实时长，区间首尾相接、无缺口。
- `source.frameExtraction`：记录本次检测参数与结果统计——`sceneThreshold`、`minCutGapSec`、`frameRate`、`rawCutCount`（原始切点）、`cutCount`（去重后切点）、`shotCount`、`reused`、`boundariesFile`。
- `shot-boundaries-<参数>-<指纹>.json`：镜头边界单独落盘，交付后复核时间码不必重跑整片解码。

切点去重只做一件事：合并同一处爆发的连续切点。ffmpeg 逐帧检测会把一次真实切换连报两帧（实测间隔 0.033 秒），不去重会得到两条零时长镜头。去重阈值默认 `--min-cut-gap 0.1` 秒，这是同一个切点的重复上报，不是镜头合并。除此之外不合并任何相邻镜头。

阈值默认 `--scene-threshold 0.25`。依据两个真实视频的全帧率评分实测：`0.3` 会漏掉插入镜头与运镜切换（28 分 20 秒样本只剩 17 个镜头），`0.2` 会把画面内运动计入（同一视频涨到 56 个）。`0.25` 下两个样本分别得到 30 / 62 个镜头，经画面复核多出的切点均为真实剪辑。用户明确要求更粗或更细时可显式调整该参数，但不要用模型判断替代阈值。

`--frame-mode interval` 是另一条独立路径：按固定间隔（默认 `--frame-interval 15`）均匀抽样的候选帧，只作画面证据点，`source.shots` 为 `null`。它不做切点判定，也不参与镜头边界。

`contactSheets` 把代表帧按 5×4 拼成 contact sheet，在进入画面描述时用于一次读取多帧画面证据。每张拼图都带 `frameNumbers`（该图真实包含的帧号）与 `paddingCells`（末尾由 ffmpeg 重复填充的格数），读取时不得把填充格当作额外证据点。

加 `--subtitles auto|youtube|whisper` 时，脚本会在同一目录下调用 `subtitle-transcribe` 并返回 `source.subtitles`：`sourceKind`、`captionKind`、`segmentCount`、`durationSec`、`report`、`artifacts` 与逐段 `segments`。字幕识别失败时脚本直接非零退出，不允许在分镜阶段静默继续。

`--media` 既可以指向用户自己提供的本地视频，也可以指向之前下载过的视频；两种情况都跳过重复下载。

### 3. Prepare subtitle evidence（默认执行）

字幕证据是默认交付的一部分，不是可选附加项。除第 4 条点名的两种情况外，都必须在本步拿到真实字幕证据，再进入交付；不得因为「没传 `--subtitles`」就让「声音/对白」整列留空。

`--subtitles` 是分镜流程读取字幕证据的唯一入口；也可以在准备好本地视频后单独调用该 skill：

```powershell
& F:\aigc\aigc\.venv\Scripts\python.exe .agents\skills\subtitle-transcribe\scripts\transcribe_subtitles.py `
  --media "<本地视频路径>" `
  --video-id "<videoId>" `
  --out-dir "<分镜输出目录>/subtitles" `
  --mode auto
```

逐段事实文件是 `subtitles/<videoId>_transcript_segments.json`。把其中的 `start`/`end`/`text`/`speaker` 按时间区间结构映射到分镜表的 `dialogue` 与 `audio` 字段：一个镜头区间内可能有零条或多条字幕，全部按原样并入，不合并相邻字幕片段、不润色文本、不改写标点。映射只做时间区间匹配，不做正文关键词判断。

`--subtitles whisper`（本地文件）或 `--subtitles auto`（链接）是默认交付的一部分，不是可选装饰：分镜表里「声音/对白」这一列是固定表头，只要源视频含对白，就必须有真实字幕证据。仅当用户明确说了“不要对白/只要时间码”，或源视频确认没有人声（例如纯音乐、纯环境音）时，才可以不传 `--subtitles`，此时字幕证据记为 `not_requested`；「没传参数所以整列 `unknown`」不是合规交付。用户要求但对白不可得时标 `unavailable` 并写明失败原因；不能把平台自动生成字幕写成原声逐字稿。本地视频文件没有 YouTube 现成字幕，`auto` 会走本地 Whisper；此时不要为了凑字幕去下载同内容的网络版本。不要在 `--mode auto` 失败后手工改走别的接口，先向用户暴露真实原因。

### 4. Describe each shot from its representative frame（仅用户明确要求时）

这一步默认跳过。只读交付到第 3 步为止：镜头边界、时间码与可选字幕都已具备，无需读取任何画面。

仅当用户明确要求画面描述（例如“标出景别/机位/画面内容”“描述每个镜头”）时，才读取 `framePath` 与 `contactSheets` 写出该镜头的画面主体、动作与镜头语言要点。没有这类要求时，不得自行开始读图。

一旦进入这一步，按 `source.shots` 的顺序处理，并且：

- 长视频可按真实时间范围分块读取以控制上下文成本，但分块只是读取约束，不是切分依据：镜头数量与边界一律以 `source.shots` 为准，不新增、不减少、不合并。
- 把块结果按 `shotIndex` 归回脚本给出的时间轴。保留分析模型、请求时间、视频 ID 和失败信息；不要覆盖已有分析文件。
- 若同一镜头出现互相冲突的描述，保留两条并标记 `reviewRequired: true`，不得静默选择一条。

### 5. Self-review before delivery

逐条检查：

- 时间码与 `source.shots` 完全一致：单调递增、首条从 `0` 开始、末条结束于媒体时长，无负数、无反向区间、无缺口；
- 条目数量等于 `source.frameExtraction.shotCount`，没有为了“更整齐”而合并、新增或丢弃镜头；
- 画面描述项仅在用户要求时检查（每个镜头都有画面主体和至少一种镜头语言要点，未知内容明确写 `unknown`）；未要求画面描述时，该字段按契约留空或省略，不构成缺口；
- 「声音/对白」列必须逐条处理，不许整列留空：源视频含对白时，`not_requested` 仅限用户明确说“不要对白/只要时间码”，或源视频确认没有人声（纯音乐、纯环境音）；其余情况若因漏传 `--subtitles` 导致整列 `unknown`，一律视为缺项，必须补跑字幕识别后再交付；
- 音频、对白、字幕只在有证据时填写，且字幕来源、模型与片段数在交付中如实标注；
- 有 `subtitles` 证据时，分镜表的 `dialogue` 能对应到具体字幕片段的时间区间；没有就写 `unknown`，不要用画面猜测台词；
- 没有把标题/简介中的语义冒充画面事实；
- 结果能由用户用播放器时间码复核；
- 失败、低置信度和冲突均暴露给用户。

## Delivery format

默认（只读交付）输出镜头切点表与「声音/对白」列，不读取画面。「声音/对白」是固定列，不是可选列：

1. `storyboard.json`：遵循 `references/schema.md`，保存机器可读事实与 provenance；`shots[]` 填时间码与字幕字段（`dialogue`/`audio`），画面字段按契约留空。
2. `storyboard.md`：先给视频元数据和分析范围，再给分镜表，列出 `镜头号 | 时间范围 | 时长 | 声音/对白 | 复核备注`。时间范围直接写脚本算出的镜头边界（如 `00:35.000–01:10.500`），用户可据此在播放器里定位复核。全表 `unknown` 只允许出现在「源视频确认无人声」或「用户明确不要对白」的情形，并需在表外说明依据。

用户明确要求画面描述时，才增加并填满画面列，Markdown 表扩为 `镜头号 | 时间范围 | 时长 | 画面概述 | 镜头语言要点 | 声音/对白 | 置信度 | 复核备注`。

两种情况下都保留 provenance、未知字段和失败诊断。不要输出“已生成分镜图”或“已写入画布”，除非确实调用了对应工具并取得真实结果；本 skill 默认只做视频理解和分镜文本交付。代表帧与 contact sheet 是已落盘的可复核产物，报告“已就绪”只陈述脚本产出事实，不得据此暗示画面描述已完成。

## Failure reporting

失败消息必须包含：阶段（解析/媒体读取/视频理解/合并/校验）、真实错误摘要、受影响的输入（链接或本地视频路径）或时间区间、是否已有可交付的部分结果、用户可执行的下一步。不要用“网络问题”“模型异常”等笼统措辞替代原始证据。

## Anti-patterns

- 不用正则、关键词表或固定模板猜测镜头内容或类型；正则只允许做 URL/数值/类型/时间码格式校验。
- 不把脚本算出的切点交给模型复核，不为了“更整齐”而合并或拆分脚本给出的镜头。
- 用户没要求画面描述时，不逐张读取代表帧或 contact sheet；产物落盘即可，读图是显式可选步骤。
- 不在原始帧率之外的地方做场景检测：先降帧再检测会把运动误判成切换，产出的是噪声不是镜头。
- 不用模型判断替代阈值：调粒度就调 `--scene-threshold`，不要让模型决定哪里该切。
- 不把 `interval` 模式的固定抽样间隔当作镜头边界；那条路径只产出画面证据点，不产出切点。
- 不合并字幕识别结果，不润色或改写识别文本，识别出来什么就是什么。
- 不把「没传 `--subtitles`」当成合规的默认交付：源视频含对白时省略字幕识别，会让分镜表固定的「声音/对白」列整列变成 `unknown`，属缺项，必须先补跑 `subtitle-transcribe` 再交付。
- 不为了满足“至少 N 条记录”而拆分或补写；也不为了“看起来更完整”而丢弃短镜头。
- 不把生成式 AI 的创作建议混入原视频事实；如用户要再创作，另起任务并明确标注为建议。
- 不在接口失败时回退到视频标题、缩略图、搜索摘要或旧分析结果。
- 不对用户已提供的本地视频文件重复下载，也不擅自把本地文件替换成网络版本。
- 不在本 skill 中重新实现下载器；下载问题统一依据 `video-downloader` 的 `download-report.json` 报告定位。

## References

- 需要精确字段和示例时读取 `references/schema.md`。
- 需要准备输入（YouTube 链接或本地视频）时执行 `scripts/prepare-youtube.mjs --help`。
- 字幕识别的能力、产物与失败契约见 `.agents/skills/subtitle-transcribe/SKILL.md`。
