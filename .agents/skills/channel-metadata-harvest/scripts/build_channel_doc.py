#!/usr/bin/env python3
"""把采集到的频道数据整理成中文 Markdown 文档。

输入是 receiving_server.py 落盘的 harvest.json（由页面内采集脚本产出），
输出是包含频道信息、视频总表与逐条详情的 Markdown。

用法：
  python build_channel_doc.py --input ".scratch/channel-x/harvest.json" \
    --out "docs/channel-analysis/频道资料.md"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


class DocError(RuntimeError):
    """数据不满足出文档的最低要求时显式失败。"""


def load_harvest(path: Path) -> dict:
    if not path.is_file():
        raise DocError(f"输入文件不存在：{path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DocError(f"输入不是合法 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise DocError("输入顶层必须是 JSON 对象。")
    if not isinstance(data.get("videos"), list) or not data["videos"]:
        raise DocError("输入缺少非空的 videos 数组。")
    return data


def parse_count(text: str | None) -> int | None:
    """把 '1,234' / '6万位订阅者' 这类展示文本还原成整数，无法解析时返回 None。"""
    if not text:
        return None
    cleaned = str(text).replace(",", "").replace("，", "").strip()
    wan = re.search(r"([\d.]+)\s*万", cleaned)
    if wan:
        return int(float(wan.group(1)) * 10000)
    plain = re.search(r"\d+", cleaned)
    return int(plain.group(0)) if plain else None


def format_number(value: object) -> str:
    return f"{value:,}" if isinstance(value, int) else "未获取"


def format_duration(seconds: object) -> str:
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return "未知"
    total = int(round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}小时{minutes}分{secs:02d}秒"
    return f"{minutes}分{secs:02d}秒"


def format_date(raw: object) -> str:
    text = str(raw or "")
    match = re.match(r"(\d{4})-(\d{2})-(\d{2})", text)
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}" if match else (text or "未知")


def format_timestamp(raw: str) -> str:
    """把 ISO 时间整理成可读形式；无法解析时原样返回。"""
    match = re.match(r"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})", raw)
    return f"{match.group(1)} {match.group(2)}" if match else raw


def escape_cell(text: object) -> str:
    return str(text or "").replace("|", "\\|").replace("\n", " ").strip()


def sorted_videos(videos: list[dict]) -> list[dict]:
    return sorted(
        videos,
        key=lambda video: (str(video.get("uploadDate") or ""), str(video.get("id") or "")),
        reverse=True,
    )


def build_document(data: dict) -> str:
    channel = data.get("channel") or {}
    videos = sorted_videos(data["videos"])
    harvested_at = str(data.get("harvestedAt") or "未记录")

    durations = [v["durationSeconds"] for v in videos if isinstance(v.get("durationSeconds"), (int, float))]
    total_seconds = int(sum(durations))
    total_views = sum(v["viewCount"] for v in videos if isinstance(v.get("viewCount"), int))
    total_likes = sum(v["likeCount"] for v in videos if isinstance(v.get("likeCount"), int))
    total_comments = sum(v["commentCount"] for v in videos if isinstance(v.get("commentCount"), int))
    like_coverage = sum(1 for v in videos if isinstance(v.get("likeCount"), int))
    comment_coverage = sum(1 for v in videos if isinstance(v.get("commentCount"), int))
    dates = sorted(str(v.get("uploadDate") or "") for v in videos if v.get("uploadDate"))

    lines: list[str] = []
    lines.append(f"# {channel.get('name') or '未命名频道'} 频道资料汇总")
    lines.append("")
    lines.append(f"> 数据抓取时间：{format_timestamp(harvested_at)}　|　数据来源：YouTube 频道页与视频页接口　|　视频样本：{len(videos)} 条")
    lines.append("")
    lines.append(
        "本文档集中收录该频道的名称、简介与全部视频元数据（标题、封面、简介、时长、发布时间、互动数据）。"
        "标题与简介为频道原文，未做改写；未能采集到的字段标注为“未获取”。"
    )
    lines.append("")

    lines.append("## 一、频道基本信息")
    lines.append("")
    lines.append("| 字段 | 内容 |")
    lines.append("| --- | --- |")
    lines.append(f"| 频道名称 | {channel.get('name') or '未获取'} |")
    lines.append(f"| 频道 ID | {channel.get('channelId') or '未获取'} |")
    lines.append(f"| 频道链接 | {channel.get('url') or '未获取'} |")
    subscriber_text = channel.get("subscriberCountText")
    subscriber_count = parse_count(subscriber_text)
    if subscriber_text and subscriber_count is not None:
        lines.append(f"| 订阅数 | {subscriber_text}（约 {subscriber_count:,}） |")
    elif subscriber_text:
        lines.append(f"| 订阅数 | {subscriber_text} |")
    else:
        lines.append("| 订阅数 | 未获取 |")
    lines.append(f"| 收录视频数 | {len(videos)} |")
    lines.append(f"| 视频总时长 | {format_duration(total_seconds)} |")
    lines.append(f"| 单条平均时长 | {format_duration(total_seconds / len(videos))} |")
    lines.append(f"| 总播放量 | {format_number(total_views)} |")
    lines.append(f"| 总点赞量 | {format_number(total_likes)}（{like_coverage}/{len(videos)} 条可获取） |")
    lines.append(f"| 总评论量 | {format_number(total_comments)}（{comment_coverage}/{len(videos)} 条可获取） |")
    if dates:
        lines.append(f"| 发布区间 | {format_date(dates[0])} 至 {format_date(dates[-1])} |")
    lines.append(f"| 频道头像 | {channel.get('avatarUrl') or '未获取'} |")
    lines.append(f"| 频道横幅 | {channel.get('bannerUrl') or '未获取'} |")
    lines.append("")

    lines.append("### 频道简介（原文）")
    lines.append("")
    lines.append("```text")
    lines.append(str(channel.get("description") or "").strip() or "未获取")
    lines.append("```")
    lines.append("")

    keywords = channel.get("keywords") or []
    lines.append("### 频道关键词")
    lines.append("")
    lines.append("　".join(f"`{item}`" for item in keywords) if keywords else "未获取")
    lines.append("")

    lines.append("## 二、视频元数据总表")
    lines.append("")
    lines.append("| # | 标题 | 时长 | 发布日 | 播放 | 点赞 | 评论 | 链接 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for index, video in enumerate(videos, start=1):
        lines.append(
            "| {index} | {title} | {duration} | {date} | {views} | {likes} | {comments} | {url} |".format(
                index=index,
                title=escape_cell(video.get("title")),
                duration=format_duration(video.get("durationSeconds")),
                date=format_date(video.get("uploadDate")),
                views=format_number(video.get("viewCount")),
                likes=format_number(video.get("likeCount")),
                comments=format_number(video.get("commentCount")),
                url=video.get("url") or "",
            )
        )
    lines.append("")

    lines.append("## 三、逐条视频详情")
    lines.append("")
    for index, video in enumerate(videos, start=1):
        lines.append(f"### {index}. {video.get('title') or '未获取标题'}")
        lines.append("")
        lines.append(f"- 视频 ID：`{video.get('id')}`")
        lines.append(f"- 链接：{video.get('url') or '未获取'}")
        lines.append(f"- 时长：{format_duration(video.get('durationSeconds'))}")
        lines.append(f"- 发布日：{format_date(video.get('uploadDate'))}")
        lines.append(
            "- 互动数据：播放 {views}　点赞 {likes}　评论 {comments}".format(
                views=format_number(video.get("viewCount")),
                likes=format_number(video.get("likeCount")),
                comments=format_number(video.get("commentCount")),
            )
        )
        lines.append(f"- 分类：{video.get('category') or '未获取'}")
        lines.append(f"- 封面：{video.get('thumbnailUrl') or '未获取'}")
        tags = video.get("tags") or []
        lines.append(f"- 标签（{len(tags)} 个）：{'　'.join(f'`{tag}`' for tag in tags) if tags else '未获取'}")
        chapters = video.get("chapters") or []
        if chapters:
            lines.append(f"- 章节（{len(chapters)} 个）：")
            for chapter in chapters:
                start = format_duration(chapter.get("start_time"))
                lines.append(f"  - {start}　{chapter.get('title') or ''}")
        lines.append("")
        lines.append("**简介（原文）**")
        lines.append("")
        lines.append("```text")
        lines.append(str(video.get("description") or "").strip() or "未获取")
        lines.append("```")
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="把频道采集数据整理成中文文档")
    parser.add_argument("--input", required=True, help="harvest.json 路径")
    parser.add_argument("--out", required=True, help="输出 Markdown 路径")
    args = parser.parse_args()

    try:
        data = load_harvest(Path(args.input).resolve())
        document = build_document(data)
    except DocError as error:
        print(f"[error] {error}", file=sys.stderr)
        return 1

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(document, encoding="utf-8")
    print(f"已写入 {out_path}")
    print(f"  视频 {len(data['videos'])} 条，正文 {len(document)} 字")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
