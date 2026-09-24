# 字幕识别产物结构

## `<video_id>_transcript_segments.json`

```json
{
  "schemaVersion": "subtitle-transcribe/v1",
  "videoId": "VIDEO_ID",
  "generatedAt": "ISO-8601",
  "source": {
    "kind": "youtube_manual_captions|youtube_auto_captions|whisper",
    "provider": "youtube_transcript_api|openai-whisper",
    "url": "string|null",
    "media": "string|null",
    "caption_kind": "manual|auto_generated",
    "caption_language": "string",
    "caption_language_name": "string",
    "detected_language": "string|null",
    "language_probability": "number|null",
    "transcription_model": "whisper-base",
    "youtube_error_before_fallback": "string|null"
  },
  "speakerLabelling": {
    "enabled": false,
    "source": "pyannote/speaker-diarization-3.1|null",
    "speaker_count": 0
  },
  "segmentCount": 0,
  "durationSec": 0,
  "segments": [
    {
      "start": 0.0,
      "end": 2.4,
      "text": "识别文本",
      "speaker": "Speaker 1"
    }
  ]
}
```

字段约束：

- `segments` 按 `start` 升序，时间单位是秒，保留 3 位小数。
- `start`、`end`、`text` 必定存在；`text` 非空。
- `end > start`；结束时间来自片段自带的 `end` 或 `start + duration`，缺失或非法时脚本直接失败。
- `speaker` 只在 `--with-speakers` 且 pyannote 真实分离成功时出现，格式为 `Speaker N`。
- `durationSec` 为全部片段的最大 `end`，用于校验时间码不超过素材时长。
- `source.kind` 与 `speakerLabelling` 一起确定可追溯性：平台自动字幕与 Whisper 识别都不是人工校对稿。
- `youtube_error_before_fallback` 只在 `--mode auto` 且 YouTube 字幕读取失败、实际改用 Whisper 时出现，用来证明换路原因，避免被读成“本来就走本地识别”。

## `subtitle-recognition-report.json`

```json
{
  "created_at": "ISO-8601",
  "video_id": "VIDEO_ID",
  "mode": "auto|youtube|whisper",
  "url": "string|null",
  "media": "string|null",
  "output_dir": "string",
  "artifacts": {
    "transcript": "string",
    "source_subtitles": "string",
    "segments": "string",
    "srt": "string"
  },
  "status": "ok|reused|failed",
  "source": {
    "kind": "youtube_manual_captions|youtube_auto_captions|whisper|existing_artifacts_origin_unknown",
    "provider": "string"
  },
  "reused_source_mode": "auto|youtube|whisper|null",
  "speaker_labelling": {}
}
```

状态含义：

- `ok`：本次真实识别并写入全部产物。
- `reused`：四个产物已齐备且非空，未重新识别；`source.kind` 取自上次报告，读不到时写 `existing_artifacts_origin_unknown`，并记录上次使用的 `reused_source_mode`。
- `failed`：识别失败；报告包含 `error` 原始信息与 `diagnostics`，此时不会留下半套产物。

显式指定 `--mode youtube` 或 `--mode whisper` 时，复用前会核对已有产物的来源类型：要求现成字幕却命中本地识别产物、或要求本地识别却命中现成字幕产物，都会直接失败并提示 `--force` 或更换 `--out-dir`，不允许用另一种来源冒充本次请求。

报告中的 `youtube_error_before_fallback` 记录 `auto` 模式下 YouTube 字幕失败的真实原因，便于区分“本来就没字幕”和“网络/接口不可达”。

## 文本产物

- `<video_id>_transcript.txt`：每行一条 `[Speaker N: ]text`，纯文本，供播客流水线读取。
- `<video_id>_source_subtitles.txt`：每行 `[mm:ss] [Speaker N: ]text`，供人工快速核对时间点。
- `<video_id>_transcript.srt`：标准 SRT，`HH:MM:SS,mmm --> HH:MM:SS,mmm`。
