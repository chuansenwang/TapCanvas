---
name: video-downloader
description: 当用户给出视频链接，要求下载视频、保存 YouTube/B 站/抖音/TikTok 等视频，或要求“下载视频并准备字幕”“为播客流水线准备转录文本”“提取 YouTube 字幕/没有字幕时转写音频”时必须使用。本 skill 支持 yt-dlp 平台与视频直链下载、YouTube 官方字幕优先提取、Whisper 兜底转写，以及生成可直接传给 AIGC `run_podcast_pipeline()` 的 `{video_id}_transcript.txt` 和可追溯报告。
---

# 视频下载与字幕准备

把用户给的视频链接下载成本地视频文件，并在需要时准备可交给播客流水线的字幕文本。直链视频走流式下载，平台视频和 m3u8 走 `yt-dlp`；YouTube 优先提取现成字幕，字幕不可用时才下载或复用音频并由 Whisper 转写。

## 适用边界

- 用于单个或明确获准批量下载的视频，以及为 AIGC 播客流水线准备输入字幕。
- 支持 YouTube、Bilibili、Vimeo、X/Twitter、TikTok、抖音、Instagram、Facebook、m3u8/mpd 和常见视频直链。
- 只需下载视频时，不运行字幕准备脚本。
- 只需把已有文本交给流水线时，不下载视频或重新转写，直接将 UTF-8 文本作为 `transcript_file` 传入。
- 不是网页正文、图片和附件采集工具；该需求应使用网页采集技能。
- 播放列表、合集、频道或 UP 主页默认不批量下载，必须取得用户明确许可后才加 `--playlist`。

## 依赖

- 项目 Python 环境，建议通过 `uv run python` 执行。
- `yt-dlp` 和 `ffmpeg`：下载平台视频或从 URL 提取转写音频时需要。
- `youtube-transcript-api`：提取 YouTube 已有字幕时需要。
- `openai-whisper`：YouTube 无字幕或用户指定本地视频转写时需要。
- `pyannote/speaker-diarization-3.1`：传入 `--with-speakers` 时用于把 Whisper 片段映射到真实说话人；需要已配置 `HF_TOKEN`。未配置或模型不可用时，项目 `AudioService` 会按停顿做简易交替标注，并在报告中保留该回退事实。

## 默认输出

视频下载文件保存到：

```text
Video/Downloads/YYYY-MM-DD-主题/
├── 下载的视频文件.mp4
├── 下载的视频文件.info.json
├── download-report.md
└── download-report.json
```

字幕准备文件默认保存到项目流水线工作目录：

```text
resources/podcast_outputs/<video_id>/
├── <video_id>_transcript.txt          # 可作为 transcript_file 传给流水线
├── <video_id>_source_subtitles.txt    # 保留时间戳的来源字幕；ASR 时存在
├── <video_id>_diarization.wav          # 仅 --with-speakers 时生成并复用
└── subtitle-preparation-report.json   # 字幕来源、复用状态和文件校验结果
```

下载目录与字幕目录分别管理：视频下载是原始资产，字幕目录是流水线输入。不要把 `download-report.md` 或 `.info.json` 误当成字幕文件。

## 常用命令

单个链接：

```bash
uv run python apps/agents-cli/skills/tapcanvas-video-downloader/scripts/download_video.py \
  --title "主题名" \
  "https://www.bilibili.com/video/BV..."
```

多个链接：

```bash
uv run python apps/agents-cli/skills/tapcanvas-video-downloader/scripts/download_video.py \
  --title "主题名" \
  "https://www.youtube.com/watch?v=..." \
  "https://www.bilibili.com/video/BV..."
```

遇到 YouTube bot 验证、B 站 412、登录可见内容：

```bash
uv run python apps/agents-cli/skills/tapcanvas-video-downloader/scripts/download_video.py \
  --cookies-file "cookies/cookies.txt" \
  --title "主题名" \
  "视频链接"
```

命令行临时调试仍支持 `--browser-cookies chrome`，但网页服务应使用 `--cookies-file`，避免服务进程反复唤起 Chrome/Safari。

YouTube 无 cookie 时若 `yt-dlp` 被登录校验拦截，脚本默认会再尝试 Invidious `local=true` 代理 fallback，优先保存 360p progressive MP4。若明确只允许官方 `yt-dlp` 路线，可加：

```bash
--no-invidious-fallback
```

下载播放列表、合集、频道列表时，用户必须明确要整组下载，再加：

```bash
--playlist
```

下载更高清时：

```bash
--quality best
```

默认限制为 1080p，避免无意下载超大文件。用户明确要最高画质时才使用 `--quality best`。

准备 YouTube 字幕，并写入流水线默认目录：

```bash
uv run python apps/agents-cli/skills/tapcanvas-video-downloader/scripts/prepare_subtitles.py \
  --url "https://www.youtube.com/watch?v=VIDEO_ID"
```

为已经下载的视频准备字幕。优先尝试其 YouTube URL 的现成字幕，失败后复用本地视频做 Whisper 转写：

```bash
uv run python apps/agents-cli/skills/tapcanvas-video-downloader/scripts/prepare_subtitles.py \
  --url "https://www.youtube.com/watch?v=VIDEO_ID" \
  --media "Video/Downloads/2026-08-11-主题/video.mp4" \
  --with-speakers
```

非 YouTube 本地视频必须显式指定 Whisper 模式和媒体文件：

```bash
uv run python apps/agents-cli/skills/tapcanvas-video-downloader/scripts/prepare_subtitles.py \
  --media "D:/media/source.mp4" \
  --video-id "source" \
  --mode whisper \
  --with-speakers
```

需要覆盖已经核验过的字幕文件时，才加 `--force`；否则脚本会复用非空的 `{video_id}_transcript.txt`，避免重复下载和重复转写。

## 执行流程

1. 先检查用户目标目录和流水线目录是否已有同一视频的非空视频、字幕或报告。存在时复用，缺失时才补齐。
2. 确认用户给的是视频链接或视频直链；网页正文、图片和附件采集不在本技能范围。
3. 需要视频时运行 `scripts/download_video.py`。未特别要求时使用单视频、1080p；播放列表必须显式加 `--playlist`。
4. 需要字幕时运行 `scripts/prepare_subtitles.py`：YouTube 先提取指定语言的现成字幕，`auto` 模式只在该步骤失败后转写。
5. Whisper 兜底时优先复用下载的视频；未提供本地媒体时才由脚本下载音频。流水线需要说话人角色时加 `--with-speakers`，脚本会先复用或转换为单声道 16 kHz WAV，再交给项目的 pyannote 模型分离；模型不可用时才回退为基于停顿的交替标注。
6. 遇到 YouTube 登录、bot、cookies 或 captcha，下载脚本会尝试 Invidious fallback；若仍失败或用户需要高画质，使用用户提供的 `--cookies-file` 重试。B 站遇到 412/403/登录限制同样仅用用户提供的 cookies 文件重试。
7. 完成前实际检查视频文件、`{video_id}_transcript.txt` 和对应报告均存在、非空且 UTF-8 可读。仅有命令成功日志或任务进度不能算完成。
8. 最终说明实际下载和字幕来源、输出目录、成功文件、复用情况，以及可直接传入 `run_podcast_pipeline(..., transcript_file=...)` 的路径。

## 字幕来源与格式

| 来源 | 选择条件 | 流水线文本 | 可追溯文件 |
| --- | --- | --- | --- |
| YouTube 现成字幕 | URL 有效且 API 可读取指定语言 | 去除时间戳后的每行文本 | `*_source_subtitles.txt` 保留 `[mm:ss]` |
| Whisper + pyannote | 无可用 YouTube 字幕，或用户指定 `--mode whisper` | 普通文本；`--with-speakers` 时为模型识别的 `Speaker N: text`，模型不可用时回退为停顿交替标签 | `*_source_subtitles.txt` 保留 `[mm:ss]` |
| 用户现有文本 | 用户已给出/提供 UTF-8 字幕文本 | 不改写内容，直接作为 `transcript_file` | 由调用方保留原文件 |

本技能不把 VTT/SRT 原样交给 `run_podcast_pipeline()`，因为当前流水线读取的是 UTF-8 纯文本。若用户需要烧录字幕、SRT 或 VTT，需在后续视频合成步骤额外处理，不能把当前 `*_subtitles.json`（播客配音时间线）误用为源视频字幕。

## 平台策略

- mp4/webm/mov/m4v/mkv/flv/ogv 直链：脚本直接流式下载，保留 Referer 和 User-Agent。
- m3u8、YouTube、Bilibili、Vimeo、X/Twitter、TikTok、抖音等：交给 `yt-dlp`。
- YouTube 直连被登录校验拦截时：尝试 Invidious `local=true` 代理端点，使用 Range 小块续传保存 360p MP4。
- 默认 `--no-playlist`，避免一个链接意外下载整套列表。
- 默认 `--max-video-mb 2000`，超出时失败并记录到报告。
- 默认 `--write-info-json`，保留视频元数据，方便后续追溯来源。

## 收尾检查

下载后至少运行：

```bash
Get-ChildItem "Video/Downloads/本次目录" -File
Get-Content -Raw "Video/Downloads/本次目录/download-report.md"
```

字幕准备后至少运行：

```bash
Get-Item "resources/podcast_outputs/VIDEO_ID/VIDEO_ID_transcript.txt"
Get-Content -TotalCount 10 "resources/podcast_outputs/VIDEO_ID/VIDEO_ID_transcript.txt"
Get-Content -Raw "resources/podcast_outputs/VIDEO_ID/subtitle-preparation-report.json"
```

如果本任务只下载视频或准备字幕，报告不含外链图片，无需调用图床技能。
