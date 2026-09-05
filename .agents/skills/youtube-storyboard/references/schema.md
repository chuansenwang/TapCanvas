# Storyboard Schema

`storyboard.json` 顶层结构：

```json
{
  "schemaVersion": "youtube-storyboard/v1",
  "source": {
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "videoId": "VIDEO_ID",
    "title": "string",
    "durationSec": 0,
    "channel": "string|unknown",
    "publishedAt": "string|unknown",
    "directMedia": { "mimeType": "video/mp4", "resolved": true, "frameFormat": "png" }
  },
  "analysis": {
    "granularity": "standard",
    "model": "string",
    "chunks": [{ "startSec": 0, "endSec": 120, "status": "complete" }],
    "subtitleEvidence": "available|unavailable|not_requested",
    "generatedAt": "ISO-8601"
  },
  "shots": [
    {
      "shotId": "S001",
      "startSec": 0,
      "endSec": 3.2,
      "durationSec": 3.2,
      "shotType": "wide|medium|close_up|extreme_close_up|overhead|unknown",
      "camera": {
        "angle": "eye_level|high|low|overhead|unknown",
        "movement": "static|pan|tilt|dolly|handheld|zoom|unknown",
        "lensOrPerspective": "string|unknown"
      },
      "visual": "string",
      "action": "string",
      "audio": "string|unknown",
      "dialogue": "string|unknown",
      "transition": "cut|dissolve|fade|wipe|match_cut|unknown",
      "confidence": 0.0,
      "reviewRequired": false,
      "evidence": { "chunkStartSec": 0, "chunkEndSec": 120 }
    }
  ],
  "diagnostics": []
}
```

`confidence` 必须在 `0..1`。任何无法从视频直接确认的字段使用 `unknown`，不要用空字符串掩盖缺失证据。`diagnostics` 用于记录解析失败、块冲突、字幕缺失和低置信度区间。
