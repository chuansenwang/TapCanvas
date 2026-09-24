---
name: video-downloader
description: 当用户给出视频链接，要求下载视频、保存 YouTube/B 站/抖音/TikTok 等视频，或要求“下载视频和音频”时必须使用。本 skill 支持 yt-dlp 平台与视频直链下载、平台音频提取与可追溯下载报告；需要把视频识别成字幕时改用 `subtitle-transcribe` skill。
---

# 视频下载

把用户给的视频链接下载成本地视频文件或音频文件。直链视频走流式下载，平台视频和 m3u8 走 `yt-dlp`。

字幕识别不在本 skill 内：需要字幕时加载并调用 `subtitle-transcribe`（`.agents/skills/subtitle-transcribe/SKILL.md`），把本地视频路径交给它。

## 适用边界

- 用于单个或明确获准批量下载的视频。
- 支持 YouTube、Bilibili、Vimeo、X/Twitter、TikTok、抖音、Instagram、Facebook、m3u8/mpd 和常见视频直链。
- 只需识别字幕时，交给 `subtitle-transcribe`；本 skill 不承担转写。
- 只需把已有文本交给流水线时，不下载视频或重新转写，直接将 UTF-8 文本作为 `transcript_file` 传入。
- 不是网页正文、图片和附件采集工具；该需求应使用网页采集技能。
- 播放列表、合集、频道或 UP 主页默认不批量下载，必须取得用户明确许可后才加 `--playlist`。

## 依赖

- 项目 Python 环境，建议通过 `uv run python` 执行。
- `yt-dlp` 和 `ffmpeg`：下载平台视频，或按需提取音频时需要。

## 默认输出

视频下载文件保存到：

```text
Video/Downloads/YYYY-MM-DD-主题/
├── 下载的视频文件.mp4
├── 下载的视频文件.info.json
├── download-report.md
└── download-report.json
```

下载目录只保存原始资产。字幕产物由 `subtitle-transcribe` 独立写入 `resources/podcast_outputs/<video_id>/`；不要把 `download-report.md` 或 `.info.json` 当作字幕文件，也不要让两个 skill 混写同一个目录。

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

把已下载视频的音频单独抽出（转写请改用 `subtitle-transcribe`）：

```bash
yt-dlp -x --audio-format wav --audio-quality 0 \
  -o "Video/Downloads/本次目录/audio.%(ext)s" \
  "视频链接"
```

## 执行流程

1. 先检查用户目标目录是否已有同一视频的非空视频文件或下载报告。存在时复用，缺失时才补齐。
2. 确认用户给的是视频链接或视频直链；网页正文、图片和附件采集不在本技能范围。
3. 需要视频时运行 `scripts/download_video.py`。未特别要求时使用单视频、1080p；播放列表必须显式加 `--playlist`。
4. 需要字幕时改用 `subtitle-transcribe`：把本 skill 下载得到的本地视频路径通过 `--media` 交给它，不要在下载 skill 内重新实现转写。
5. 遇到 YouTube 登录、bot、cookies 或 captcha，下载脚本会尝试 Invidious fallback；若仍失败或用户需要高画质，使用用户提供的 `--cookies-file` 重试。B 站遇到 412/403/登录限制同样仅用用户提供的 cookies 文件重试。
6. 完成前实际检查视频文件与 `download-report.json` 均存在、大小非零。仅有命令成功日志或任务进度不能算完成。
7. 最终说明下载来源、输出目录、成功文件与复用情况；若用户还要字幕，说明已交给 `subtitle-transcribe` 并给出其产物路径。

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

字幕产物由 `subtitle-transcribe` 负责校验，见该 skill 的收尾检查。
