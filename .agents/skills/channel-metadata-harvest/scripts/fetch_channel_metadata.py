#!/usr/bin/env python3
"""抓取 YouTube 频道的频道信息与全部视频元数据。

只读取公开信息，不下载视频文件。产出两个 JSON：
  channel.json  频道名称、简介、标签、头像、横幅、订阅数
  videos.json   每条视频的标题、封面、简介、时长、发布时间、互动数据

用法：
  python fetch_channel_metadata.py --url "https://www.youtube.com/@handle" --out ".scratch/channel-x"
  python fetch_channel_metadata.py --url "https://www.youtube.com/watch?v=xxxx" --out ".scratch/channel-x"
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_PLAYER_CLIENTS = "android,web_embedded,ios"

VIDEO_FIELDS = (
    "id,title,description,duration,upload_date,view_count,like_count,"
    "comment_count,tags,categories,thumbnail,chapters"
)


class HarvestError(RuntimeError):
    """采集失败，必须显式中断并保留已获取的数据。"""


def run_ytdlp(args: list[str], timeout: int) -> str:
    """执行 yt-dlp，返回 stdout。失败时抛出包含 stderr 的 HarvestError。"""
    proc = subprocess.run(
        ["yt-dlp", *args],
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    stdout = proc.stdout.decode("utf-8", errors="strict")
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", errors="strict").strip()
        raise HarvestError(f"yt-dlp 退出码 {proc.returncode}：{stderr[-1500:]}")
    return stdout


def parse_json_lines(output: str, source: str) -> list[dict]:
    records: list[dict] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line:
            continue
        if not line.startswith("{"):
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise HarvestError(f"{source} 返回了无法解析的 JSON 行：{exc}") from exc
    return records


def resolve_channel_url(url: str, player_clients: str, timeout: int) -> str:
    """把视频链接或频道链接统一解析成频道 URL。"""
    output = run_ytdlp(
        [
            "--skip-download",
            "--no-warnings",
            "--socket-timeout",
            "20",
            "--extractor-args",
            f"youtube:player_client={player_clients}",
            "--print",
            "%(channel_url)s",
            url,
        ],
        timeout,
    )
    candidates = [line.strip() for line in output.splitlines() if line.strip()]
    if not candidates:
        raise HarvestError(f"无法从 {url} 解析出频道地址，请确认链接可公开访问。")
    return candidates[0]


def fetch_channel_profile(channel_url: str, player_clients: str, timeout: int) -> dict:
    about_url = channel_url.rstrip("/") + "/about"
    output = run_ytdlp(
        [
            "--skip-download",
            "--no-warnings",
            "--socket-timeout",
            "20",
            "--extractor-args",
            f"youtube:player_client={player_clients}",
            "-J",
            about_url,
        ],
        timeout,
    )
    try:
        profile = json.loads(output)
    except json.JSONDecodeError as exc:
        raise HarvestError(f"频道 About 页返回了无法解析的 JSON：{exc}") from exc
    if not profile.get("channel"):
        raise HarvestError(f"频道 About 页缺少频道名称：{about_url}")
    thumbnails = profile.get("thumbnails") or []
    profile["avatar_url"] = pick_thumbnail(thumbnails, "avatar_uncropped")
    profile["banner_url"] = pick_thumbnail(thumbnails, "banner_uncropped")
    profile["channel_url"] = channel_url
    return profile


def pick_thumbnail(thumbnails: list[dict], wanted_id: str) -> str | None:
    for item in thumbnails:
        if item.get("id") == wanted_id:
            return item.get("url")
    return None


def list_channel_videos(channel_url: str, player_clients: str, timeout: int) -> list[str]:
    videos_url = channel_url.rstrip("/") + "/videos"
    output = run_ytdlp(
        [
            "--skip-download",
            "--no-warnings",
            "--socket-timeout",
            "20",
            "--extractor-args",
            f"youtube:player_client={player_clients}",
            "--flat-playlist",
            "--print",
            "%(id)s",
            videos_url,
        ],
        timeout,
    )
    ids = [line.strip() for line in output.splitlines() if line.strip()]
    deduped = list(dict.fromkeys(ids))
    if not deduped:
        raise HarvestError(f"频道视频页没有返回任何视频：{videos_url}")
    return deduped


def fetch_video_records(
    ids: list[str],
    player_clients: str,
    timeout: int,
    limit: int | None,
) -> tuple[list[dict], list[str]]:
    """批量抓取视频元数据；返回 (成功记录, 失败 id)。"""
    target = ids[:limit] if limit else ids
    urls = [f"https://www.youtube.com/watch?v={vid}" for vid in target]
    print_args = [
        "--skip-download",
        "--no-warnings",
        "--socket-timeout",
        "20",
        "--ignore-errors",
        "--extractor-args",
        f"youtube:player_client={player_clients}",
        "--print",
        f"%(.{{{VIDEO_FIELDS}}})j",
        *urls,
    ]
    try:
        output = run_ytdlp(print_args, timeout)
        records = parse_json_lines(output, "视频元数据批量抓取")
    except HarvestError as exc:
        raise HarvestError(f"批量抓取视频元数据失败：{exc}") from exc

    got = {record.get("id") for record in records}
    missing = [vid for vid in target if vid not in got]

    if missing:
        # 批量请求里个别视频失败时，逐条重试以便拿到确切失败原因并尽可能补齐。
        for vid in list(missing):
            single = print_args[:-len(urls)] + [f"https://www.youtube.com/watch?v={vid}"]
            try:
                output = run_ytdlp(single, timeout)
                records.extend(parse_json_lines(output, f"视频 {vid}"))
            except HarvestError as exc:
                print(f"[warn] 视频 {vid} 抓取失败：{exc}", file=sys.stderr)
        got = {record.get("id") for record in records}
        missing = [vid for vid in target if vid not in got]

    if missing:
        raise HarvestError(
            "以下视频元数据抓取失败，未做任何兜底填充：" + ", ".join(missing)
        )
    return records, missing


def normalize_video(record: dict) -> dict:
    """压缩字段体积，只保留写文档需要的真实数据。"""
    video_id = record.get("id")
    if not video_id:
        raise HarvestError(f"视频记录缺少 id：{record}")
    return {
        "id": video_id,
        "title": record.get("title") or "",
        "description": record.get("description") or "",
        "duration_seconds": record.get("duration"),
        "upload_date": record.get("upload_date"),
        "view_count": record.get("view_count"),
        "like_count": record.get("like_count"),
        "comment_count": record.get("comment_count"),
        "tags": record.get("tags") or [],
        "categories": record.get("categories") or [],
        "thumbnail_url": record.get("thumbnail")
        or f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg",
        "chapters": record.get("chapters") or [],
        "url": f"https://www.youtube.com/watch?v={video_id}",
    }


def sort_key(video: dict) -> tuple[str, str]:
    date = video.get("upload_date") or "00000000"
    return (date, video.get("id") or "")


def main() -> int:
    parser = argparse.ArgumentParser(description="抓取 YouTube 频道信息与视频元数据")
    parser.add_argument("--url", required=True, help="频道链接或该频道的任意视频链接")
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument(
        "--player-clients",
        default=DEFAULT_PLAYER_CLIENTS,
        help=f"yt-dlp YouTube player_client 列表，默认 {DEFAULT_PLAYER_CLIENTS}",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=900,
        help="单次 yt-dlp 调用的超时秒数，默认 900",
    )
    parser.add_argument("--limit", type=int, default=None, help="只抓取最新的前 N 条")
    args = parser.parse_args()

    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    channel_url = resolve_channel_url(args.url, args.player_clients, args.timeout)
    print(f"[1/3] 已解析频道：{channel_url}")

    profile = fetch_channel_profile(channel_url, args.player_clients, args.timeout)
    print(f"[2/3] 已获取频道信息：{profile['channel']}")

    ids = list_channel_videos(channel_url, args.player_clients, args.timeout)
    print(f"[3/3] 视频列表中 {len(ids)} 条，开始抓取元数据…")
    raw_records, _ = fetch_video_records(
        ids, args.player_clients, args.timeout, args.limit
    )
    videos = sorted((normalize_video(r) for r in raw_records), key=sort_key, reverse=True)

    harvested_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    profile_payload = {
        "harvested_at": harvested_at,
        "source_url": args.url,
        "channel_url": channel_url,
        "name": profile.get("channel"),
        "channel_id": profile.get("channel_id"),
        "follower_count": profile.get("channel_follower_count"),
        "description": profile.get("description") or "",
        "tags": profile.get("tags") or [],
        "avatar_url": profile.get("avatar_url"),
        "banner_url": profile.get("banner_url"),
    }
    videos_payload = {
        "harvested_at": harvested_at,
        "channel_url": channel_url,
        "listed_count": len(ids),
        "fetched_count": len(videos),
        "videos": videos,
    }

    (out_dir / "channel.json").write_text(
        json.dumps(profile_payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out_dir / "videos.json").write_text(
        json.dumps(videos_payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"完成：{out_dir}")
    print(f"  channel.json  频道信息")
    print(f"  videos.json   {len(videos)} 条视频元数据")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HarvestError as error:
        print(f"[error] {error}", file=sys.stderr)
        raise SystemExit(1)
