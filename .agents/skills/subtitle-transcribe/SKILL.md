---
name: subtitle-transcribe
description: 把已经下载好的视频/音频识别成带时间码的字幕事实文件。用户要求“识别字幕/转写字幕/生成 SRT/听写出对白/给视频配字幕/为分镜准备字幕证据”时必须使用；优先复用 YouTube 现成字幕，缺失时用本地 Whisper 识别，需要说话人时用 pyannote 分离。只输出真实识别结果，识别失败即显式失败。
---

# 字幕识别

把一个本地视频/音频（或可下载音频的 URL）识别成可复核、可追溯的字幕文件：纯文本稿、带时间码字幕、标准 SRT、逐段 JSON 与识别报告。

本 skill 只负责“从声音/现成字幕得到文字与时间码”。下载视频、抽帧、分镜拆解分别属于 `video-downloader` 与 `youtube-storyboard`。

## 产出的事实

一条字幕片段只有三个事实字段：`start`、`end`、`text`；启用说话人分离时额外有 `speaker`。任何缺时间码、结束早于开始、长度为零的片段都会直接失败，不会补写或猜测。

## 输入

- 必填其一：
  - `--media <本地视频或音频路径>`：已经下载好的文件，推荐路径（不重复下载）；
  - `--url <视频链接>`：需要脚本自行下载音频时使用，目前支持 `yt-dlp` 能解析的来源。
- 可选：`--video-id`（输出标识，默认取 YouTube ID 或媒体文件名）、`--out-dir`（产物目录）、`--mode`、`--languages`、`--whisper-model`、`--language`、`--with-speakers`、`--force`。

## 识别来源

| `--mode` | 行为 | 说明 |
| --- | --- | --- |
| `auto`（默认） | 先读 YouTube **人工上传**字幕，没有则本地 Whisper 识别 | 平台自动生成字幕不参与，避免把机器字幕当逐字稿 |
| `youtube` | 只用 YouTube 现成字幕，人工优先、其次平台自动字幕 | 字幕缺失即失败，不做本地转写 |
| `whisper` | 只用本地 Whisper 识别 | 需要 `--media` 或可下载音频的 `--url` |

说话人分离只支持 Whisper 来源：YouTube 现成字幕没有说话人信息，带 `--with-speakers` 时会显式失败而不是给假标签。

## 依赖

- Python 解释器：优先项目虚拟环境 `F:\aigc\aigc\.venv\Scripts\python.exe`；该环境已含 `openai-whisper`、`youtube-transcript-api`、`pyannote-audio`、`torchaudio`。
- `ffmpeg`：Whisper 解码、说话人分离音频准备需要。脚本默认使用 `D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe`，可用环境变量 `FFMPEG_PATH` 覆盖；都找不到时显式失败。
- 项目根目录：脚本向上查找含 `app/service/audio_service.py` 的目录（当前为 `F:\aigc\aigc`），也可用 `AIGC_PROJECT_ROOT` 覆盖。说话人分离复用该项目 `AudioService` 的 pyannote 链路。
- `PODCAST_OUTPUT_DIR`：可选。设置后默认输出目录改为该值下的 `<video_id>/`；相对路径按项目根解析，使脚本从任意 cwd 调用都写入同一位置，与播客流水线一致。
- `HF_TOKEN`：只有 `--with-speakers` 需要。未配置时直接失败，不使用基于停顿的猜测标签。

## 默认输出

产物写入 `<AIGC 项目根>/resources/podcast_outputs/<video_id>/`，可用 `--out-dir` 改：

```text
resources/podcast_outputs/<video_id>/
├── <video_id>_transcript.txt               # 纯文本稿，可直接作为 run_podcast_pipeline(transcript_file=...)
├── <video_id>_source_subtitles.txt         # 带 [mm:ss] 的逐行字幕
├── <video_id>_transcript.srt               # 标准 SRT，可交给播放器或烧录流程
├── <video_id>_transcript_segments.json     # 逐段事实：start/end/text/speaker + 来源 + 模型
├── <video_id>_diarization.wav              # 仅 --with-speakers 生成，可复用
└── subtitle-recognition-report.json        # 来源、模型、片段数、失败原因、复用状态
```

`*_transcript_segments.json` 是唯一给下游程序读取的事实文件；下游不得只依赖纯文本稿推断时间码。

## 常用命令

下载好的视频直接识别（推荐，`--media` 优先于重新下载）：

```powershell
& F:\aigc\aigc\.venv\Scripts\python.exe .agents\skills\subtitle-transcribe\scripts\transcribe_subtitles.py `
  --media "<本地视频路径>" `
  --video-id "<videoId>"
```

必须用 YouTube 现成字幕，不接受本地转写：

```powershell
& F:\aigc\aigc\.venv\Scripts\python.exe .agents\skills\subtitle-transcribe\scripts\transcribe_subtitles.py `
  --url "https://www.youtube.com/watch?v=VIDEO_ID" `
  --mode youtube
```

访谈/对白类内容需要说话人：

```powershell
& F:\aigc\aigc\.venv\Scripts\python.exe .agents\skills\subtitle-transcribe\scripts\transcribe_subtitles.py `
  --media "<本地视频路径>" `
  --mode whisper `
  --with-speakers
```

指定识别语言与更大模型（默认 `base`，中文或嘈杂音源可换 `small`/`medium`）：

```powershell
& F:\aigc\aigc\.venv\Scripts\python.exe .agents\skills\subtitle-transcribe\scripts\transcribe_subtitles.py `
  --media "<本地视频路径>" `
  --mode whisper `
  --language zh `
  --whisper-model small
```

复用与覆盖：四个产物（`transcript`、`source_subtitles`、`segments`、`srt`）齐备且非空时脚本直接复用并写明来源；只存在部分产物时拒绝覆盖并报出缺失清单；确认要重做时显式加 `--force`。

## 执行流程

1. 确认输入：优先使用已有本地媒体；只有确实没有本地文件时才用 `--url` 下载音频。不要为了“统一”重新下载已存在的视频。
2. 选择来源：默认 `auto`；用户明确要求“用原视频自带字幕”才用 `--mode youtube`；用户明确要求“不要用平台字幕、本地识别”才用 `--mode whisper`。
3. 识别：Whisper 使用 `--whisper-model`（默认 `base`）与可选的 `--language`；不传语言时由模型自己判定，并在报告里记录 `detected_language`。
4. 需要说话人时加 `--with-speakers`；脚本会复用或生成 16 kHz 单声道 WAV，再交给项目 pyannote 模型。
5. 校验产物：四个文件都存在、非空、UTF-8 可读；JSON 可解析；片段数与报告一致。仅有命令退出码 0 不算完成。
6. 报告结果：说明实际来源（人工字幕/平台自动字幕/Whisper）、模型、片段数、时长、产物路径，以及是否有过失败后被换路的原因。

## 失败与边界

- YouTube 无字幕、网络不可达、`yt-dlp` 无法解析、Whisper 未安装、`ffmpeg` 缺失、`HF_TOKEN` 未配置、产物为空：全部原地失败并给出真实错误，不用其他来源顶替。
- 不使用正则、关键词表或 `includes` 做语义理解；脚本里的正则只用于 URL、时间码、说话人标签格式校验。
- 不伪造进度、不臆测片段内容、不把平台自动字幕包装成人工逐字稿；平台自动字幕会在报告中标记 `caption_kind: auto_generated`。
- 不把 Whisper 识别结果标为人工校对稿：它是模型识别结果，`segments.json` 与报告都会记录 `transcription_model`。
- 不修改或覆盖用户已有的识别产物，除非显式加 `--force`。

## 供下游使用

- 播客流水线：把 `<video_id>_transcript.txt` 直接作为 `transcript_file` 传入 `run_podcast_pipeline()`。
- 分镜拆解：`youtube-storyboard` 用本 skill 的 `*_transcript_segments.json` 填充分镜表（默认段落级）的对话/声音字段，并在诊断中标注字幕来源；字幕缺失时标记 `subtitleEvidence: unavailable`，不得用标题或常识补写。
- 烧录字幕：直接使用 `<video_id>_transcript.srt`；不要用播客配音产出的 `*_subtitles.json`（那是合成语音时间线，不是源视频字幕）。

## References

- 逐段 JSON 字段说明见 `references/schema.md`。
- 脚本参数与失败信息：`scripts/transcribe_subtitles.py --help`。
- 回归测试：`tests/test_transcribe_subtitles.py`。
