import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const videos = JSON.parse(
  fs.readFileSync(path.join(repoRoot, ".scratch/ses_compact.json"), "utf8"),
);
const channelRaw = JSON.parse(
  fs.readFileSync(path.join(repoRoot, ".scratch/ses_about.json"), "utf8"),
);

const sorted = [...videos].sort((a, b) =>
  String(b.date).localeCompare(String(a.date)),
);

const fmtDuration = (seconds) => {
  const total = Math.round(Number(seconds) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}分${String(s).padStart(2, "0")}秒`;
};

const fmtDate = (raw) => {
  const t = String(raw ?? "");
  if (t.length !== 8) return t;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
};

const fmtNumber = (value) =>
  typeof value === "number" ? value.toLocaleString("en-US") : "未知";

const thumbFor = (id) => `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;

const banner = (channelRaw.thumbnails || []).find(
  (t) => t.id === "banner_uncropped",
);
const avatar = (channelRaw.thumbnails || []).find(
  (t) => t.id === "avatar_uncropped",
);

const totalViews = sorted.reduce((a, v) => a + (v.views || 0), 0);
const totalLikes = sorted.reduce((a, v) => a + (v.likes || 0), 0);
const totalComments = sorted.reduce((a, v) => a + (v.comments || 0), 0);
const totalSeconds = sorted.reduce((a, v) => a + (v.dur || 0), 0);
const durations = sorted.map((v) => v.dur || 0);
const avgDuration = totalSeconds / sorted.length;

const lines = [];

lines.push("# Slow English Stories 频道资料汇总");
lines.push("");
lines.push(
  `> 数据抓取时间：2026-09-30　|　数据来源：YouTube 频道页与各视频详情页　|　视频样本：${sorted.length} 条`,
);
lines.push("");
lines.push(
  "本文档用于频道风格拆解，集中收录频道名称、频道简介与全部视频的元数据（标题、封面、简介、时长、发布时间、互动数据）。标题与简介为频道原文，未做改写。",
);
lines.push("");
lines.push("## 一、频道基本信息");
lines.push("");
lines.push("| 字段 | 内容 |");
lines.push("| --- | --- |");
lines.push(`| 频道名称 | ${channelRaw.channel} |`);
lines.push("| 频道 handle | @slowenglishstorytv |");
lines.push(`| 频道链接 | ${channelRaw.channel_url} |`);
lines.push(`| 订阅数 | ${fmtNumber(channelRaw.channel_follower_count)} |`);
lines.push(`| 当前收录视频数 | ${sorted.length} |`);
lines.push(`| 视频总时长 | ${fmtDuration(totalSeconds)} |`);
lines.push(`| 单条平均时长 | ${fmtDuration(avgDuration)} |`);
lines.push(`| 总播放量 | ${fmtNumber(totalViews)} |`);
lines.push(`| 总点赞量 | ${fmtNumber(totalLikes)} |`);
lines.push(`| 总评论量 | ${fmtNumber(totalComments)} |`);
lines.push(
  `| 发布区间 | ${fmtDate(sorted[sorted.length - 1].date)} 至 ${fmtDate(sorted[0].date)} |`,
);
lines.push(`| 频道头像 | ${avatar ? `<${avatar.url}>` : "未获取"} |`);
lines.push(`| 频道横幅 | ${banner ? `<${banner.url}>` : "未获取"} |`);
lines.push("");
lines.push("### 频道简介（原文）");
lines.push("");
lines.push("```text");
lines.push(String(channelRaw.description ?? "").trim());
lines.push("```");
lines.push("");
lines.push("### 频道标签");
lines.push("");
lines.push(
  (channelRaw.tags || []).map((t) => `\`${t}\``).join("　"),
);
lines.push("");
lines.push("## 二、视频元数据总表");
lines.push("");
lines.push(
  "| # | 标题 | 时长 | 发布日 | 播放 | 点赞 | 评论 | 链接 |",
);
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
sorted.forEach((v, i) => {
  const title = String(v.title ?? "").replace(/\|/g, "\\|");
  lines.push(
    `| ${i + 1} | ${title} | ${fmtDuration(v.dur)} | ${fmtDate(v.date)} | ${fmtNumber(v.views)} | ${fmtNumber(v.likes)} | ${fmtNumber(v.comments)} | https://www.youtube.com/watch?v=${v.id} |`,
  );
});
lines.push("");
lines.push("## 三、逐条视频详情");
lines.push("");
sorted.forEach((v, i) => {
  lines.push(`### ${i + 1}. ${v.title}`);
  lines.push("");
  lines.push(`- 视频 ID：\`${v.id}\``);
  lines.push(`- 链接：https://www.youtube.com/watch?v=${v.id}`);
  lines.push(`- 时长：${fmtDuration(v.dur)}`);
  lines.push(`- 发布日：${fmtDate(v.date)}`);
  lines.push(
    `- 互动数据：播放 ${fmtNumber(v.views)}　点赞 ${fmtNumber(v.likes)}　评论 ${fmtNumber(v.comments)}`,
  );
  lines.push(`- 分类：${(v.cats || []).join(" / ") || "未标注"}`);
  lines.push(`- 封面：<${thumbFor(v.id)}>`);
  lines.push(`- 标签（${(v.tags || []).length} 个）：`);
  lines.push("");
  lines.push("```text");
  lines.push((v.tags || []).join(", ") || "无");
  lines.push("```");
  lines.push("");
  lines.push("**简介（原文）**");
  lines.push("");
  lines.push("```text");
  lines.push(String(v.desc ?? "").trim());
  lines.push("```");
  lines.push("");
});

const outDir = path.join(repoRoot, "docs/channel-analysis");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "Slow-English-Stories-频道资料.md");
fs.writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(`written: ${outFile}`);
console.log(`chars: ${lines.join("\n").length}`);
