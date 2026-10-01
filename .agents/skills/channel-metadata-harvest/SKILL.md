---
name: channel-metadata-harvest
description: 当用户要求把某个 YouTube 频道的频道资料和视频元数据抓下来、整理成文档或做频道资料归档时使用，输入是频道链接或该频道的任意视频链接。只做事实采集与落档，不做风格分析、拆解、模仿或二次创作；需要拆解频道风格并产出原创脚本时改用 `channel-style-cloner`。
---

# 频道元数据采集

把一个 YouTube 频道的名称、简介、标签、头像、横幅，以及全部视频的标题、封面、简介、时长、发布时间、播放量、点赞数、评论数、标签，采集下来并整理成中文 Markdown 文档。

只采集公开可见的事实字段。抓不到的字段一律留空并如实标注“未获取”，禁止用默认值、占位文本或推测内容填充。

## 适用边界

- 用于频道资料归档、竞品资料整理、后续分析的原始数据准备。
- 只做采集与落档。频道风格拆解、Style DNA、原创脚本、缩略图与标题创作不在本 skill 范围，改用 `channel-style-cloner`。
- 只采公开数据。需登录才能看到的内容、私密频道、会员专属视频不在范围内，遇到即显式失败。
- 不下载视频文件。需要视频或音频本体时改用 `video-downloader`。
- 不识别字幕。需要字幕时改用 `subtitle-transcribe`。

## 主路径：浏览器采集

YouTube 对命令行抓取有反爬限制，`yt-dlp` 会间歇性返回空结果或 `The page needs to be reloaded`。默认走浏览器路径：用 BrowserOS neo 打开频道页，在页面上下文里调用 YouTube 自身的接口取数。

### 步骤

1. 用浏览器打开目标频道的 `<频道链接>/videos` 页。用户只给了视频链接时，从该视频页点进频道，或直接访问 `https://www.youtube.com/<频道 handle>`。
2. 启动本地接收端点，用于把采集结果落盘，避免大体积文本经过对话上下文：

   ```bash
   py -3 .agents/skills/channel-metadata-harvest/scripts/receiving_server.py \
     --out ".scratch/channel-<slug>/harvest.json"
   ```

   启动后会打印监听的端口和校验令牌，两者都要记下。该端点只接受一次写入，收到数据后自动退出。

3. 读取 `scripts/collect_channel_in_page.js`，把它的内容整段交给浏览器工具的页面脚本执行能力运行。脚本按批次工作，反复执行同一段脚本，直到返回值的 `done` 为 `true`：

   - 首次执行返回 `phase: "list"`，此时已解析出频道信息和完整视频 ID 列表；
   - 之后每次执行推进一批视频，返回 `phase: "videos"` 与 `fetched` / `remaining`；
   - `phase: "error"` 表示前置条件不满足，按 `error` 字段说明处理后重试。

   进度保存在页面的 `window.__channelHarvest` 上，因此多次执行不会重复抓取。单次脚本执行有 30 秒上限，若返回时 `done` 仍为 `false`，直接再执行一次即可。

4. 脚本跑完后，把结果发回落盘端点：

   ```js
   await fetch("http://127.0.0.1:<端口>/", {
     method: "POST",
     headers: { "Content-Type": "application/json", "X-Harvest-Token": "<令牌>" },
     body: JSON.stringify({
       harvestedAt: new Date().toISOString(),
       sourceUrl: location.href,
       channel: window.__channelHarvest.channel,
       videos: window.__channelHarvest.results,
     }),
   });
   ```

   返回 204 表示已落盘。403 表示令牌不符，核对后重发。

5. 生成文档：

   ```bash
   py -3 .agents/skills/channel-metadata-harvest/scripts/build_channel_doc.py \
     --input ".scratch/channel-<slug>/harvest.json" \
     --out "docs/channel-analysis/<频道名>-频道资料.md"
   ```

### 采集字段

频道：名称、频道 ID、链接、订阅数、简介、关键词、头像、横幅。

每条视频：ID、链接、标题、简介、封面、时长、发布时间、播放量、点赞数、评论数、分类、标签。

## 备选路径：命令行采集

没有可用浏览器、或只需要一小批视频时，用 `scripts/fetch_channel_metadata.py`：

```bash
py -3 .agents/skills/channel-metadata-harvest/scripts/fetch_channel_metadata.py \
  --url "https://www.youtube.com/@handle" \
  --out ".scratch/channel-<slug>"
```

产出 `channel.json` 与 `videos.json` 两个文件，字段覆盖范围与浏览器路径相同，但文件布局不同（浏览器路径产出单个 `harvest.json`）。`build_channel_doc.py` 只接受浏览器路径的 `harvest.json`，用命令行结果出文档时需要先把这两个文件合并成 `{channel, videos}` 结构。该脚本遵守同样的约定：抓不到就显式失败，不会静默填充缺失字段。若返回 `yt-dlp` 反爬报错，改用浏览器路径，不要反复重试同一条命令。

## 落盘约定

- 中间产物放 `.scratch/`，最终文档放 `docs/channel-analysis/`。
- `harvest.json` 是采集原始数据，文档是它的派生结果；文档需要重新生成时只重跑第 5 步，不必重新采集。
- 覆盖已有文档属于改写文件，先确认目标路径，不要默认覆盖用户的既有文件。

## 收尾检查

完成前逐项确认，任一项不满足就补齐而不是直接结束：

1. `harvest.json` 存在且非空，`videos` 数组长度与频道视频数一致。
2. 每条视频的标题、简介、封面、时长、发布时间、播放量、点赞数均已取到；确实取不到的字段保留 `null`，并在交付说明里如实列出缺失项。
3. 生成的 Markdown 中，频道信息、视频总表、逐条详情三部分都存在，表行数与视频数一致。
4. 交付时说明采集时间、视频条数、文档路径，以及未获取到的字段。

## 已知限制

- 评论数依赖评论区的延迟加载令牌，部分视频取不到，此时该字段为 `null`，不要用 0 代替。
- 视频章节信息在当前接口路径下拿不到，`chapters` 恒为空数组；确需章节时用备选路径的 `yt-dlp` 结果补。
- 订阅数在页面上是 `6万位订阅者` 这类展示文本，文档中会原样保留并给出近似整数。
- 未登录状态下频道接口不会返回全部字段，缺失一律按“未获取”处理。
