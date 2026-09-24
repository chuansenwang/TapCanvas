# Storyboard Schema

`storyboard.json` 顶层结构：

```json
{
  "schemaVersion": "youtube-storyboard/v1",
  "source": {
    "url": "https://www.youtube.com/watch?v=VIDEO_ID|null",
    "videoId": "VIDEO_ID",
    "title": "string",
    "durationSec": 0,
    "channel": "string|unknown",
    "publishedAt": "string|unknown",
    "directVideoUrl": "string|null",
    "mimeType": "video/mp4|video/webm|video/quicktime|video/x-matroska|video/x-m4v",
    "localVideoPath": "string",
    "shots": [
      {
        "shotIndex": 1,
        "startSec": 0,
        "endSec": 4.267,
        "durationSec": 4.267,
        "sampleTimeSec": 2.134,
        "frameNumber": 64,
        "framePath": "candidate-frames-scene-0.25-gap0.1-<源文件指纹>/frame-0001.png",
        "cutScore": 0.258856
      }
    ],
    "candidateFrames": ["candidate-frames-scene-0.25-gap0.1-<源文件指纹>/frame-0001.png"],
    "frameExtraction": {
      "tool": "ffmpeg",
      "format": "png",
      "mode": "scene|interval",
      "intervalSec": null,
      "sceneThreshold": 0.25,
      "minCutGapSec": 0.1,
      "frameRate": 30,
      "rawCutCount": 31,
      "cutCount": 29,
      "shotCount": 30,
      "reused": false,
      "boundariesFile": "shot-boundaries-scene-0.25-gap0.1-<源文件指纹>.json"
    },
    "contactSheets": [
      {
        "path": "candidate-sheets-interval-15s-<源文件指纹>/sheet-001.png",
        "layout": "5x4",
        "frameNumbers": [1, 2, 3],
        "paddingCells": 17
      }
    ],
    "subtitles": "object|null"
  },
  "analysis": {
    "granularity": "shot",
    "timePrecision": "detected_cut_seconds",
    "model": "string",
    "chunks": [{ "startSec": 0, "endSec": 120, "status": "complete" }],
    "subtitleEvidence": "available|unavailable|not_requested",
    "subtitleProvenance": {
      "sourceKind": "youtube_manual_captions|youtube_auto_captions|whisper",
      "captionKind": "manual|auto_generated|null",
      "transcriptionModel": "whisper-base|string|null",
      "speakerLabelling": "pyannote/speaker-diarization-3.1|null",
      "segmentCount": 0,
      "segmentsFile": "string",
      "reportFile": "string",
      "failedReason": "string|null"
    },
    "generatedAt": "ISO-8601"
  },
  "shots": [
    {
      "shotId": "S001",
      "shotIndex": 1,
      "startSec": 0,
      "endSec": 4.267,
      "durationSec": 4.267,
      "visual": "string",
      "action": "string",
      "shotLanguage": "string|unknown",
      "audio": "string|unknown",
      "dialogue": "string|unknown",
      "transition": "cut|dissolve|fade|wipe|match_cut|unknown",
      "confidence": 0.0,
      "reviewRequired": false,
      "evidence": {
        "representativeFrame": "candidate-frames-scene-0.25-gap0.1-<源文件指纹>/frame-0001.png"
      }
    }
  ],
  "diagnostics": []
}
```

`confidence` 必须在 `0..1`。任何无法从视频直接确认的字段使用 `unknown`，不要用空字符串掩盖缺失证据。`diagnostics` 用于记录解析失败、块冲突、字幕缺失和低置信度区间。

### 粒度与时间精度

- `granularity=shot`：每条记录对应一个脚本检测出的真实镜头。镜头边界由 ffmpeg 场景检测在全帧率上算出，不由模型决定，也不做后续合并。
- `timePrecision=detected_cut_seconds`：`startSec`/`endSec` 是脚本算出的切点（秒，三位小数），首条从 `0` 开始、末条结束于媒体真实时长，区间首尾相接。
- `shots` 数组的条目数量必须等于 `source.frameExtraction.shotCount`；描述模型只填充画面内容字段，不得增删或合并条目。
- `evidence.representativeFrame` 是该镜头的代表帧路径（取镜头中点），与 `source.shots[].framePath` 一致。

### 镜头检测字段

- `source.shots[]` 由 `prepare-youtube.mjs` 的 scene 模式产出：`shotIndex` 从 1 递增，`sampleTimeSec` 为镜头中点，`frameNumber` 为对应帧号，`cutScore` 为该镜头起始切点的 ffmpeg 场景评分（首个镜头为 `null`，因为片头不是切点）。
- `source.frameExtraction.rawCutCount` 是 ffmpeg 原始上报的切点数；`cutCount` 是合并同一处爆发后的切点数；`shotCount` 等于镜头数（即 `cutCount + 1`）。
- `source.frameExtraction.reused=true` 表示本次复用了同视频同参数的上一次检测结果；参数（阈值、去重间隔）或视频变化都会落到新的产物目录，不会串用。
- `shot-boundaries-<参数>-<指纹>.json` 与 `source.shots` 内容一致，用于交付后复核时间码而不必重跑解码。
- `--frame-mode interval` 时 `source.shots` 为 `null`：那条路径只按固定间隔抽样画面证据点，不做切点判定。
- `source.contactSheets[].frameNumbers` 是该拼图真实包含的帧号；`paddingCells` 是末尾由 ffmpeg 重复填充的格数，读取时必须忽略这些填充格。
- `source.frameExtraction.reused=true` 表示本次复用了已有候选帧（同一视频、同一抽帧参数），不是重新抽帧。
- `source.url` 与 `source.directVideoUrl` 在本地视频文件输入时为 `null`：分镜证据来自 `localVideoPath` 的抽帧，不需要也不允许伪造媒体直链。此时 `durationSec` 由 `ffprobe` 从本地媒体读出（探测失败即显式失败，不留 `null`），`mimeType` 按真实扩展名给出；旁有同名 `.info.json` 时按其内容补齐元数据，目录里其他视频的 `.info.json` 不参与。
- 上述 `source` 字段是 `prepare-youtube.mjs` 的实际输出契约；`storyboard.json` 直接沿用这些字段，不要改名或另造平行结构。
