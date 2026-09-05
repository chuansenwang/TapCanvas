#!/usr/bin/env python3
"""Prepare a UTF-8 transcript file that the podcast pipeline can consume."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_OUTPUT_ROOT = PROJECT_ROOT / "resources" / "podcast_outputs"
MEDIA_EXTENSIONS = {".mp4", ".webm", ".mov", ".m4v", ".mkv", ".flv", ".ogv", ".wav", ".mp3", ".m4a"}

# Direct script execution makes its scripts/ directory the import root.
# Add the repository root before reusing project services such as AudioService.
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def extract_youtube_video_id(url: str) -> str:
    patterns = (
        r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/|live/))([0-9A-Za-z_-]{11})",
        r"(?:youtu\.be/)([0-9A-Za-z_-]{11})",
    )
    for pattern in patterns:
        match = re.search(pattern, url or "")
        if match:
            return match.group(1)
    return ""


def format_timestamp(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    return f"{total_seconds // 60:02d}:{total_seconds % 60:02d}"


def normalise_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\n", " ")).strip()


def normalise_segments(items: Iterable[Any]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, dict):
            start = item.get("start", 0)
            end = item.get("end")
            text = item.get("text", "")
        else:
            start = getattr(item, "start", 0)
            end = getattr(item, "end", None)
            text = getattr(item, "text", "")
        text = normalise_text(str(text))
        if text:
            segments.append({"start": float(start or 0), "end": end, "text": text})
    return segments


def fetch_youtube_subtitles(url: str, languages: list[str]) -> list[dict[str, Any]]:
    video_id = extract_youtube_video_id(url)
    if not video_id:
        raise ValueError("无法从 URL 识别 YouTube video_id")

    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    if hasattr(api, "fetch"):
        transcript = api.fetch(video_id, languages=languages)
    else:
        transcript = YouTubeTranscriptApi.get_transcript(video_id, languages=languages)
    segments = normalise_segments(transcript)
    if not segments:
        raise ValueError("YouTube 返回的字幕为空")
    return segments


def find_media(path: Path) -> Path:
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"媒体文件不存在: {path}")
    if path.suffix.lower() not in MEDIA_EXTENSIONS:
        raise ValueError(f"不支持的媒体格式: {path.suffix}")
    return path


def download_audio(url: str, output_dir: Path, video_id: str) -> Path:
    ytdlp = shutil.which("yt-dlp")
    if not ytdlp:
        raise RuntimeError("未找到 yt-dlp；请先安装依赖或通过 --media 提供本地媒体文件")
    template = output_dir / f"{video_id}_source_audio.%(ext)s"
    command = [
        ytdlp,
        "--no-playlist",
        "--extract-audio",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "--output",
        str(template),
        url,
    ]
    subprocess.run(command, check=True)
    candidates = sorted(output_dir.glob(f"{video_id}_source_audio.*"))
    if not candidates:
        raise RuntimeError("yt-dlp 未生成可用音频文件")
    return candidates[0]


def prepare_diarization_audio(media_path: Path, output_dir: Path, video_id: str) -> Path:
    """Return a WAV file pyannote can decode reliably on the supported Windows setup."""
    if media_path.suffix.lower() == ".wav":
        return media_path

    output_path = output_dir / f"{video_id}_diarization.wav"
    if output_path.is_file() and output_path.stat().st_size > 0:
        return output_path
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg，无法将视频转换为 pyannote 所需的 WAV 音频")
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(media_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    # ffmpeg output encoding follows its own build settings on Windows. Keep
    # bytes here so a non-GBK diagnostic cannot make a successful conversion noisy.
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
        raw_detail = result.stderr or result.stdout
        detail = raw_detail.decode("utf-8", errors="replace").strip().splitlines() if raw_detail else []
        raise RuntimeError(f"无法准备说话人分离音频: {detail[-1] if detail else '未知错误'}")
    return output_path


def transcribe_media(media_path: Path, model_name: str) -> list[dict[str, Any]]:
    try:
        import whisper
    except ImportError as exc:
        raise RuntimeError("未安装 openai-whisper，无法执行 Whisper 转写") from exc
    result = whisper.load_model(model_name).transcribe(str(media_path))
    return normalise_segments(result.get("segments", []))


def label_speakers(media_path: Path, segments: list[dict[str, Any]]) -> tuple[list[str], str]:
    """Reuse the application's pyannote path without running Whisper a second time."""
    from app.service.audio_service import audio_service

    diarization_available = audio_service.diarization_pipeline is not None
    transcript = audio_service.transcribe_with_speakers(media_path, segments=segments)
    lines = [line.strip() for line in transcript.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("说话人分离未返回可用文本")
    source = "pyannote/speaker-diarization-3.1" if diarization_available else "gap_alternation_fallback"
    return lines, source


def write_transcript_files(
    output_dir: Path,
    video_id: str,
    segments: list[dict[str, Any]],
    *,
    source: str,
    with_speakers: bool,
    speaker_lines: list[str] | None = None,
) -> dict[str, str]:
    if not segments:
        raise ValueError("没有可写入的字幕片段")
    source_path = output_dir / f"{video_id}_source_subtitles.txt"
    transcript_path = output_dir / f"{video_id}_transcript.txt"
    source_lines = [f"[{format_timestamp(item['start'])}] {item['text']}" for item in segments]
    source_path.write_text("\n".join(source_lines) + "\n", encoding="utf-8")

    if with_speakers and source == "whisper" and speaker_lines:
        transcript_lines = speaker_lines
    else:
        transcript_lines = [item["text"] for item in segments]
    transcript_path.write_text("\n".join(transcript_lines) + "\n", encoding="utf-8")
    return {"source_subtitles": str(source_path), "transcript": str(transcript_path)}


def valid_transcript(path: Path) -> bool:
    try:
        return path.is_file() and bool(path.read_text(encoding="utf-8").strip())
    except UnicodeDecodeError:
        return False


def write_report(output_dir: Path, payload: dict[str, Any]) -> Path:
    report_path = output_dir / "subtitle-preparation-report.json"
    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare a podcast-pipeline transcript from a video URL or local media.")
    parser.add_argument("--url", default="", help="Source video URL; YouTube subtitles are available only with a YouTube URL")
    parser.add_argument("--media", default="", help="Existing local video/audio file to reuse for Whisper fallback")
    parser.add_argument("--video-id", default="", help="Output identifier; defaults to YouTube ID or local media stem")
    parser.add_argument("--out-dir", default="", help="Transcript output directory; defaults to resources/podcast_outputs/<video_id>")
    parser.add_argument("--mode", choices=("auto", "youtube", "whisper"), default="auto", help="Subtitle source strategy")
    parser.add_argument("--languages", default="en,zh-Hans,zh-Hant", help="Comma-separated YouTube subtitle language preferences")
    parser.add_argument("--whisper-model", default="base", help="Whisper model for fallback transcription")
    parser.add_argument("--with-speakers", action="store_true", help="Label Whisper fallback lines as Speaker 1 for pipeline input")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing non-empty pipeline transcript")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    media_path = find_media(Path(args.media).expanduser()) if args.media else None
    youtube_id = extract_youtube_video_id(args.url)
    video_id = args.video_id or youtube_id or (media_path.stem if media_path else "")
    if not video_id:
        raise SystemExit("请提供有效的 --url、--media 或 --video-id")
    if args.mode == "youtube" and not youtube_id:
        raise SystemExit("--mode youtube 只能用于有效的 YouTube URL")
    if args.mode == "whisper" and not (media_path or args.url):
        raise SystemExit("--mode whisper 需要 --media 或可下载音频的 --url")

    output_dir = Path(args.out_dir).expanduser() if args.out_dir else DEFAULT_OUTPUT_ROOT / video_id
    output_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = output_dir / f"{video_id}_transcript.txt"
    base_report: dict[str, Any] = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "video_id": video_id,
        "url": args.url or None,
        "output_dir": str(output_dir),
        "transcript": str(transcript_path),
        "mode": args.mode,
    }
    if valid_transcript(transcript_path) and not args.force:
        report = write_report(output_dir, {**base_report, "status": "reused", "source": "existing_transcript"})
        print(json.dumps({"status": "reused", "transcript": str(transcript_path), "report": str(report)}, ensure_ascii=False))
        return 0
    if not args.url and media_path is None:
        raise SystemExit("未找到可复用字幕；请提供 --url 或 --media")

    languages = [language.strip() for language in args.languages.split(",") if language.strip()]
    segments: list[dict[str, Any]] = []
    source = ""
    youtube_error = ""
    if args.mode in {"auto", "youtube"}:
        try:
            segments = fetch_youtube_subtitles(args.url, languages)
            source = "youtube_transcript_api"
        except Exception as exc:  # noqa: BLE001
            youtube_error = str(exc)
            if args.mode == "youtube":
                report = write_report(output_dir, {**base_report, "status": "failed", "source": "youtube_transcript_api", "error": youtube_error})
                print(json.dumps({"status": "failed", "report": str(report), "error": youtube_error}, ensure_ascii=False))
                return 1

    if not segments:
        if media_path is None:
            media_path = download_audio(args.url, output_dir, video_id)
        segments = transcribe_media(media_path, args.whisper_model)
        source = "whisper"

    speaker_lines = None
    speaker_diarization = None
    diarization_audio = None
    if source == "whisper" and args.with_speakers:
        diarization_audio = prepare_diarization_audio(media_path, output_dir, video_id)
        speaker_lines, speaker_diarization = label_speakers(diarization_audio, segments)
    files = write_transcript_files(
        output_dir,
        video_id,
        segments,
        source=source,
        with_speakers=args.with_speakers,
        speaker_lines=speaker_lines,
    )
    if not valid_transcript(transcript_path):
        raise RuntimeError("字幕文件写入后为空或不可按 UTF-8 读取")
    report = write_report(
        output_dir,
        {
            **base_report,
            "status": "ok",
            "source": source,
            "segment_count": len(segments),
            "source_subtitles": files["source_subtitles"],
            "media": str(media_path) if media_path else None,
            "diarization_audio": str(diarization_audio) if diarization_audio else None,
            "youtube_error_before_fallback": youtube_error or None,
            "transcription_model": f"whisper-{args.whisper_model}" if source == "whisper" else None,
            "speaker_diarization": speaker_diarization,
        },
    )
    print(json.dumps({"status": "ok", "source": source, "transcript": files["transcript"], "report": str(report)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
