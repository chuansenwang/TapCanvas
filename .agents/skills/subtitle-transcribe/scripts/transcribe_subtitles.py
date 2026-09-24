#!/usr/bin/env python3
"""把视频/音频识别成带时间码的字幕事实文件。

字幕来源只有两条真实路径：
1. YouTube 现成字幕（`--mode youtube`，或 `--mode auto` 命中人工上传字幕时）；
2. 本地 Whisper 转写（可叠加 pyannote 说话人分离）。

不猜测、不补写、不静默降级：任何来源缺失或产物不完整都直接失败并写明原因。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

SKILL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LANGUAGES = "en,zh-Hans,zh-Hant"
MEDIA_EXTENSIONS = {
    ".mp4",
    ".webm",
    ".mov",
    ".m4v",
    ".mkv",
    ".flv",
    ".ogv",
    ".wav",
    ".mp3",
    ".m4a",
    ".aac",
    ".flac",
    ".opus",
    ".ogg",
}
SCHEMA_VERSION = "subtitle-transcribe/v1"
YOUTUBE_ID_PATTERNS = (
    r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/|live/))([0-9A-Za-z_-]{11})",
    r"(?:youtu\.be/)([0-9A-Za-z_-]{11})",
)
# 只做格式校验，不用它判断语义。
SPEAKER_LABEL_PATTERN = re.compile(r"^Speaker \d+$")

# 调用方（Node 脚本、自动化流水线）统一按 UTF-8 读取 stdout/stderr，
# 避免 Windows 默认代码页把中文诊断写成不可解析的字节。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def extract_youtube_video_id(url: str) -> str:
    for pattern in YOUTUBE_ID_PATTERNS:
        match = re.search(pattern, url or "")
        if match:
            return match.group(1)
    return ""


def format_clock_timestamp(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    return f"{total_seconds // 60:02d}:{total_seconds % 60:02d}"


def format_srt_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def normalise_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\n", " ")).strip()


def normalise_segments(items: Iterable[Any]) -> list[dict[str, Any]]:
    """把 YouTube 片段或 Whisper 片段统一成 {start, end, text}。

    起止时间非法（缺失结束时间且没有时长、或结束早于开始）时显式失败，
    不允许补写时间码。
    """
    segments: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, dict):
            start = item.get("start", 0)
            end = item.get("end")
            duration = item.get("duration")
            text = item.get("text", "")
        else:
            start = getattr(item, "start", 0)
            end = getattr(item, "end", None)
            duration = getattr(item, "duration", None)
            text = getattr(item, "text", "")
        text = normalise_text(str(text))
        if not text:
            continue
        start_value = float(start or 0)
        if end is not None:
            end_value = float(end)
        elif duration is not None:
            end_value = start_value + float(duration)
        else:
            raise ValueError(f"字幕片段缺少结束时间与时长: start={start_value} text={text!r}")
        if end_value <= start_value:
            raise ValueError(f"字幕片段时间码非法: start={start_value} end={end_value} text={text!r}")
        segments.append(
            {"start": round(start_value, 3), "end": round(end_value, 3), "text": text}
        )
    segments.sort(key=lambda segment: segment["start"])
    return segments


def find_media(path: Path) -> Path:
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"媒体文件不存在: {path}")
    if path.suffix.lower() not in MEDIA_EXTENSIONS:
        raise ValueError(f"不支持的媒体格式: {path.suffix}")
    return path


def resolve_ffmpeg() -> str:
    override = os.environ.get("FFMPEG_PATH", "").strip()
    if override:
        if not Path(override).is_file():
            raise FileNotFoundError(f"FFMPEG_PATH 指向的文件不存在: {override}")
        return override
    windows_default = Path(r"D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe")
    if windows_default.is_file():
        return str(windows_default)
    found = shutil.which("ffmpeg")
    if not found:
        raise RuntimeError(
            "未找到 ffmpeg：请设置 FFMPEG_PATH、把 ffmpeg 加入 PATH，"
            r"或确认 D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe 存在"
        )
    return found


def resolve_project_root() -> Path:
    """定位含 `app/service/audio_service.py` 的 AIGC 项目根目录。

    路径只作为结构性事实解析，可用环境变量 `AIGC_PROJECT_ROOT` 覆盖；
    解析不到时显式失败，不回退到任意目录。
    """
    override = os.environ.get("AIGC_PROJECT_ROOT", "").strip()
    candidates: list[Path] = []
    if override:
        candidates.append(Path(override).expanduser())
    candidates.extend(Path(__file__).resolve().parents)
    for candidate in candidates:
        if (candidate / "app" / "service" / "audio_service.py").is_file():
            return candidate
    raise RuntimeError(
        "未找到 AIGC 项目根目录（需要 app/service/audio_service.py）："
        "请设置 AIGC_PROJECT_ROOT 指向包含 app/ 的项目根目录"
    )


def default_output_dir(video_id: str) -> Path:
    """默认写入播客流水线的字幕目录，与 `PODCAST_OUTPUT_DIR` 保持一致。

    `PODCAST_OUTPUT_DIR` 是相对路径时按 AIGC 项目根解析，因为本脚本会被
    从任意工作目录调用，不能依赖当前 cwd。
    """
    project_root = resolve_project_root()
    configured = os.environ.get("PODCAST_OUTPUT_DIR", "").strip()
    base = Path(configured).expanduser() if configured else Path("resources") / "podcast_outputs"
    if not base.is_absolute():
        base = project_root / base
    return base / video_id


def download_audio(url: str, output_dir: Path, video_id: str) -> Path:
    if not url:
        raise ValueError("需要 --url 才能下载音频")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        if Path(url).is_file():
            raise ValueError(f"--url 收到的是本地文件路径: {url}；本地文件请改用 --media")
        raise ValueError(f"--url 必须是 http(s) 视频链接，收到: {url}")
    ytdlp = shutil.which("yt-dlp")
    if not ytdlp:
        raise RuntimeError("未找到 yt-dlp；请安装依赖或通过 --media 提供本地媒体文件")
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
    """给 pyannote 准备 16 kHz 单声道 WAV；输入已是 WAV 时直接复用。"""
    if media_path.suffix.lower() == ".wav":
        return media_path
    output_path = output_dir / f"{video_id}_diarization.wav"
    if output_path.is_file() and output_path.stat().st_size > 0:
        return output_path
    ffmpeg = resolve_ffmpeg()
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
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0 or not output_path.is_file() or output_path.stat().st_size == 0:
        raw_detail = result.stderr or result.stdout
        detail = (
            raw_detail.decode("utf-8", errors="replace").strip().splitlines() if raw_detail else []
        )
        raise RuntimeError(f"无法准备说话人分离音频: {detail[-1] if detail else '未知错误'}")
    return output_path


def transcribe_with_whisper(
    media_path: Path, model_name: str, language: str
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    resolve_ffmpeg()  # Whisper 依赖 ffmpeg 解码音频，先给出可读的缺失原因。
    try:
        import whisper
    except ImportError as exc:
        raise RuntimeError("未安装 openai-whisper，无法执行本地转写") from exc
    result = whisper.load_model(model_name).transcribe(
        str(media_path), language=language or None
    )
    segments = normalise_segments(result.get("segments", []))
    if not segments:
        raise RuntimeError(f"Whisper 未识别出任何字幕片段: {media_path}")
    meta = {
        "detected_language": result.get("language"),
        "language_probability": result.get("language_probability"),
        "transcription_model": f"whisper-{model_name}",
    }
    return segments, meta


def label_speakers(
    diarization_audio: Path, segments: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """用项目 AudioService 的 pyannote 链路给每个片段标注说话人。

    AudioService 在 pyannote 不可用时会按停顿猜说话人，这里先检查模型可用性，
    拿不到真实分离结果就失败，绝不写入猜测出来的说话人。
    """
    project_root = resolve_project_root()
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    from app.service.audio_service import audio_service

    if audio_service.diarization_pipeline is None:
        raise RuntimeError(
            "pyannote 说话人分离不可用（缺少 HF_TOKEN 或模型未安装）；"
            "--with-speakers 需要真实分离结果，不使用基于停顿的猜测标签"
        )
    transcript = audio_service.transcribe_with_speakers(
        diarization_audio, segments=[dict(segment) for segment in segments]
    )
    lines = [line.strip() for line in transcript.splitlines() if line.strip()]
    if len(lines) != len(segments):
        raise RuntimeError(
            "说话人标签与字幕片段数量不一致，AudioService 合并契约可能已变更："
            f"segments={len(segments)} lines={len(lines)}"
        )
    labelled: list[dict[str, Any]] = []
    speakers: list[str] = []
    for segment, line in zip(segments, lines):
        label, separator, text = line.partition(": ")
        if not separator or not SPEAKER_LABEL_PATTERN.match(label):
            raise RuntimeError(
                "说话人标签格式不符合 AudioService 约定 'Speaker N: text'，"
                f"实际为: {line[:60]!r}"
            )
        if label not in speakers:
            speakers.append(label)
        labelled.append({**segment, "speaker": label, "text": text.strip() or segment["text"]})
    meta = {
        "enabled": True,
        "source": "pyannote/speaker-diarization-3.1",
        "speaker_count": len(speakers),
    }
    return labelled, meta


def fetch_youtube_captions(
    url: str, languages: list[str], allow_generated: bool
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """读取 YouTube 现成字幕，并记录它是否由平台自动生成。"""
    video_id = extract_youtube_video_id(url)
    if not video_id:
        raise ValueError(f"不是可解析的 YouTube URL: {url}")
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import NoTranscriptFound
    except ImportError as exc:
        raise RuntimeError("未安装 youtube-transcript-api，无法读取 YouTube 现成字幕") from exc

    listing = YouTubeTranscriptApi().list(video_id)
    transcript = None
    caption_kind = ""
    manual_error = ""
    try:
        transcript = listing.find_manually_created_transcript(languages)
        caption_kind = "manual"
    except NoTranscriptFound as exc:
        manual_error = str(exc)
    if transcript is None and allow_generated:
        try:
            transcript = listing.find_generated_transcript(languages)
            caption_kind = "auto_generated"
        except NoTranscriptFound as exc:
            raise ValueError(
                f"YouTube 没有可用字幕（人工/自动均缺失）: {languages}；人工字幕错误: {manual_error}；"
                f"自动字幕错误: {exc}"
            ) from exc
    if transcript is None:
        raise ValueError(
            f"YouTube 没有 {languages} 的人工上传字幕（自动字幕仅在 --mode youtube 下使用）: {manual_error}"
        )
    fetched = transcript.fetch()
    segments = normalise_segments(fetched.to_raw_data())
    if not segments:
        raise ValueError("YouTube 返回的字幕为空")
    meta = {
        "caption_kind": caption_kind,
        "caption_language": transcript.language_code,
        "caption_language_name": transcript.language,
    }
    return segments, meta


def render_srt(segments: list[dict[str, Any]]) -> str:
    blocks = []
    for index, segment in enumerate(segments, start=1):
        start = format_srt_timestamp(segment["start"])
        end = format_srt_timestamp(segment["end"])
        blocks.append(f"{index}\n{start} --> {end}\n{segment['text']}")
    return "\n\n".join(blocks) + "\n"


def render_timed_text(segments: list[dict[str, Any]]) -> str:
    lines = []
    for segment in segments:
        prefix = f"{segment['speaker']}: " if segment.get("speaker") else ""
        lines.append(f"[{format_clock_timestamp(segment['start'])}] {prefix}{segment['text']}")
    return "\n".join(lines) + "\n"


def render_plain_text(segments: list[dict[str, Any]]) -> str:
    lines = []
    for segment in segments:
        prefix = f"{segment['speaker']}: " if segment.get("speaker") else ""
        lines.append(f"{prefix}{segment['text']}")
    return "\n".join(lines) + "\n"


def artifact_paths(output_dir: Path, video_id: str) -> dict[str, Path]:
    return {
        "transcript": output_dir / f"{video_id}_transcript.txt",
        "source_subtitles": output_dir / f"{video_id}_source_subtitles.txt",
        "segments": output_dir / f"{video_id}_transcript_segments.json",
        "srt": output_dir / f"{video_id}_transcript.srt",
    }


def valid_artifact(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size == 0:
        return False
    if path.suffix == ".json":
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False
        return True
    try:
        return bool(path.read_text(encoding="utf-8").strip())
    except UnicodeDecodeError:
        return False


def write_artifacts(
    output_dir: Path,
    video_id: str,
    segments: list[dict[str, Any]],
    source: dict[str, Any],
    speaker_meta: dict[str, Any],
) -> dict[str, str]:
    paths = artifact_paths(output_dir, video_id)
    paths["transcript"].write_text(render_plain_text(segments), encoding="utf-8")
    paths["source_subtitles"].write_text(render_timed_text(segments), encoding="utf-8")
    paths["srt"].write_text(render_srt(segments), encoding="utf-8")
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "videoId": video_id,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": source,
        "speakerLabelling": speaker_meta,
        "segmentCount": len(segments),
        "durationSec": max(segment["end"] for segment in segments),
        "segments": segments,
    }
    paths["segments"].write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {name: str(path) for name, path in paths.items()}


def write_report(output_dir: Path, payload: dict[str, Any]) -> Path:
    report_path = output_dir / "subtitle-recognition-report.json"
    report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return report_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="识别视频/音频字幕：YouTube 现成字幕或本地 Whisper 转写（+ 说话人分离）。"
    )
    parser.add_argument("--url", default="", help="视频来源 URL；只有 YouTube URL 能读现成字幕")
    parser.add_argument("--media", default="", help="已下载的本地视频/音频文件，优先复用，不再重复下载")
    parser.add_argument("--video-id", default="", help="输出标识；默认取 YouTube ID 或媒体文件名")
    parser.add_argument(
        "--out-dir",
        default="",
        help="产物目录；默认写入 <AIGC 项目根>/resources/podcast_outputs/<video_id>",
    )
    parser.add_argument(
        "--mode",
        choices=("auto", "youtube", "whisper"),
        default="auto",
        help="auto=人工字幕优先、否则本地转写；youtube=只用现成字幕；whisper=只用本地转写",
    )
    parser.add_argument(
        "--languages", default=DEFAULT_LANGUAGES, help="YouTube 字幕语言优先级，逗号分隔"
    )
    parser.add_argument("--whisper-model", default="base", help="Whisper 模型名，默认 base")
    parser.add_argument(
        "--language", default="", help="Whisper 识别语言（如 en/zh）；留空则由模型自动判定"
    )
    parser.add_argument(
        "--with-speakers", action="store_true", help="用 pyannote 标注真实说话人；模型不可用时失败"
    )
    parser.add_argument("--force", action="store_true", help="覆盖已存在的完整字幕产物")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        media_path = find_media(Path(args.media).expanduser()) if args.media else None
        youtube_id = extract_youtube_video_id(args.url)
        video_id = args.video_id or youtube_id or (media_path.stem if media_path else "")
        if not video_id:
            raise ValueError("请提供有效的 --url、--media 或 --video-id")

        output_dir = Path(args.out_dir).expanduser() if args.out_dir else default_output_dir(video_id)
        output_dir.mkdir(parents=True, exist_ok=True)
        paths = artifact_paths(output_dir, video_id)
        report_path = output_dir / "subtitle-recognition-report.json"
        base_report: dict[str, Any] = {
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "video_id": video_id,
            "mode": args.mode,
            "url": args.url or None,
            "media": str(media_path) if media_path else None,
            "output_dir": str(output_dir),
            "artifacts": {name: str(path) for name, path in paths.items()},
        }

        complete = all(valid_artifact(path) for path in paths.values())
        if complete and not args.force:
            reused_source = "existing_artifacts_origin_unknown"
            reused_mode = None
            if report_path.is_file():
                try:
                    previous = json.loads(report_path.read_text(encoding="utf-8"))
                    reused_source = (previous.get("source") or {}).get("kind") or reused_source
                    reused_mode = previous.get("mode")
                except (UnicodeDecodeError, json.JSONDecodeError):
                    reused_source = "existing_artifacts_origin_unreadable"
            caption_kinds = {"youtube_manual_captions", "youtube_auto_captions"}
            if args.mode == "youtube" and reused_source not in caption_kinds:
                raise RuntimeError(
                    "--mode youtube 要求现成字幕，但目标目录已有非 YouTube 字幕产物"
                    f"（实际来源 {reused_source}，目录 {output_dir}）；"
                    "请改用 --mode auto/whisper，确认后加 --force 重新识别，或换 --out-dir"
                )
            if args.mode == "whisper" and reused_source in caption_kinds:
                raise RuntimeError(
                    "--mode whisper 要求本地识别，但目标目录已有 YouTube 现成字幕产物"
                    f"（实际来源 {reused_source}，目录 {output_dir}）；"
                    "请改用 --mode auto/youtube，确认后加 --force 重新识别，或换 --out-dir"
                )
            write_report(
                output_dir,
                {
                    **base_report,
                    "status": "reused",
                    "source": {"kind": reused_source},
                    "reused_source_mode": reused_mode,
                    "diagnostics": ["复用已有字幕产物，未重新识别"],
                },
            )
            print(
                json.dumps(
                    {
                        "status": "reused",
                        "source": reused_source,
                        "reusedSourceMode": reused_mode,
                        "artifacts": base_report["artifacts"],
                        "report": str(report_path),
                    },
                    ensure_ascii=False,
                )
            )
            return 0

        # 复用了已有产物就不必再识别，因此来源合法性校验放在复用判断之后。
        if args.mode == "youtube" and not youtube_id:
            raise ValueError("--mode youtube 只能用于有效的 YouTube URL")
        if args.mode == "whisper" and media_path is None and not args.url:
            raise ValueError("--mode whisper 需要 --media 或可下载音频的 --url")

        stale = sorted(name for name, path in paths.items() if path.exists() and not complete)
        if stale and not args.force:
            raise RuntimeError(
                "检测到不完整的字幕产物，拒绝覆盖已有文件："
                f"{stale}（目录 {output_dir}）；请确认后删除，或显式加 --force 重新识别"
            )

        languages = [item.strip() for item in args.languages.split(",") if item.strip()]
        segments: list[dict[str, Any]] = []
        source_meta: dict[str, Any] = {"url": args.url or None, "media": str(media_path) if media_path else None}
        youtube_error = ""
        if args.mode in {"auto", "youtube"} and youtube_id:
            try:
                segments, caption_meta = fetch_youtube_captions(
                    args.url, languages, allow_generated=args.mode == "youtube"
                )
                source_meta.update(
                    {
                        "kind": (
                            "youtube_manual_captions"
                            if caption_meta["caption_kind"] == "manual"
                            else "youtube_auto_captions"
                        ),
                        "provider": "youtube_transcript_api",
                        **caption_meta,
                    }
                )
            except Exception as exc:  # noqa: BLE001 - 需要把原始原因写进报告
                youtube_error = str(exc)
                if args.mode == "youtube":
                    write_report(
                        output_dir,
                        {
                            **base_report,
                            "status": "failed",
                            "source": {"kind": "youtube_captions", "provider": "youtube_transcript_api"},
                            "error": youtube_error,
                            "diagnostics": ["--mode youtube 要求现成字幕存在，缺失即失败"],
                        },
                    )
                    print(json.dumps({"status": "failed", "error": youtube_error}, ensure_ascii=False))
                    return 1

        speaker_meta: dict[str, Any] = {"enabled": False, "source": None, "speaker_count": 0}
        diarization_audio: Path | None = None
        if not segments:
            if media_path is None:
                media_path = download_audio(args.url, output_dir, video_id)
                base_report["media"] = str(media_path)
                source_meta["media"] = str(media_path)
            segments, whisper_meta = transcribe_with_whisper(
                media_path, args.whisper_model, args.language
            )
            source_meta.update({"kind": "whisper", "provider": "openai-whisper", **whisper_meta})
            if args.with_speakers:
                diarization_audio = prepare_diarization_audio(media_path, output_dir, video_id)
                segments, speaker_meta = label_speakers(diarization_audio, segments)
        elif args.with_speakers:
            raise RuntimeError(
                "--with-speakers 只支持 Whisper 转写来源：YouTube 现成字幕没有说话人分离结果，"
                "请改用 --mode whisper"
            )

        if youtube_error:
            # auto 模式下换用本地转写时必须留下真实原因，避免“静默换路”。
            source_meta["youtube_error_before_fallback"] = youtube_error
        artifacts = write_artifacts(output_dir, video_id, segments, source_meta, speaker_meta)
        for name, path in paths.items():
            if not valid_artifact(path):
                raise RuntimeError(f"字幕产物写入后为空或不可读: {name} -> {path}")
        report = write_report(
            output_dir,
            {
                **base_report,
                "status": "ok",
                "source": source_meta,
                "speaker_labelling": speaker_meta,
                "segment_count": len(segments),
                "duration_sec": max(segment["end"] for segment in segments),
                "diarization_audio": str(diarization_audio) if diarization_audio else None,
                "youtube_error_before_fallback": youtube_error or None,
                "diagnostics": [],
            },
        )
        print(
            json.dumps(
                {
                    "status": "ok",
                    "source": source_meta.get("kind"),
                    "captionKind": source_meta.get("caption_kind"),
                    "speakerLabelling": speaker_meta,
                    "segmentCount": len(segments),
                    "artifacts": artifacts,
                    "report": str(report),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001 - 统一输出可读失败原因
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False))
        print(f"字幕识别失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
