from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "transcribe_subtitles.py"
SPEC = importlib.util.spec_from_file_location("transcribe_subtitles", SCRIPT)
transcribe_subtitles = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(transcribe_subtitles)


def write_complete_artifacts(output_dir: Path, video_id: str) -> None:
    for name, path in transcribe_subtitles.artifact_paths(output_dir, video_id).items():
        if name == "segments":
            path.write_text(json.dumps({"segments": []}), encoding="utf-8")
        else:
            path.write_text("占位内容\n", encoding="utf-8")


class TranscribeSubtitlesTests(unittest.TestCase):
    def test_project_root_exposes_audio_service(self):
        project_root = transcribe_subtitles.resolve_project_root()
        self.assertTrue((project_root / "app" / "service" / "audio_service.py").is_file())

    def test_default_output_dir_honours_podcast_output_dir(self):
        project_root = transcribe_subtitles.resolve_project_root()
        self.assertEqual(
            transcribe_subtitles.default_output_dir("sample"),
            project_root / "resources" / "podcast_outputs" / "sample",
        )
        previous = os.environ.get("PODCAST_OUTPUT_DIR")
        os.environ["PODCAST_OUTPUT_DIR"] = str(Path("custom") / "outputs")
        try:
            self.assertEqual(
                transcribe_subtitles.default_output_dir("sample"),
                project_root / "custom" / "outputs" / "sample",
            )
        finally:
            if previous is None:
                os.environ.pop("PODCAST_OUTPUT_DIR", None)
            else:
                os.environ["PODCAST_OUTPUT_DIR"] = previous

    def test_extract_youtube_video_id(self):
        self.assertEqual(
            transcribe_subtitles.extract_youtube_video_id("https://youtu.be/BaW_jenozKc"),
            "BaW_jenozKc",
        )
        self.assertEqual(
            transcribe_subtitles.extract_youtube_video_id(
                "https://www.youtube.com/shorts/BaW_jenozKc"
            ),
            "BaW_jenozKc",
        )
        self.assertEqual(
            transcribe_subtitles.extract_youtube_video_id("https://example.com/video"), ""
        )

    def test_normalise_segments_uses_duration_and_sorts(self):
        segments = transcribe_subtitles.normalise_segments(
            [
                {"text": "  Second   line ", "start": 65.0, "duration": 2.0},
                {"start": 2.9, "end": 4.0, "text": "First line"},
            ]
        )
        self.assertEqual(
            segments,
            [
                {"start": 2.9, "end": 4.0, "text": "First line"},
                {"start": 65.0, "end": 67.0, "text": "Second line"},
            ],
        )

    def test_normalise_segments_rejects_missing_or_invalid_timecode(self):
        with self.assertRaises(ValueError):
            transcribe_subtitles.normalise_segments([{"text": "no timing"}])
        with self.assertRaises(ValueError):
            transcribe_subtitles.normalise_segments(
                [{"text": "reversed", "start": 5.0, "end": 3.0}]
            )
        with self.assertRaises(ValueError):
            transcribe_subtitles.normalise_segments(
                [{"text": "zero length", "start": 5.0, "duration": 0}]
            )

    def test_render_srt_and_plain_text(self):
        segments = [
            {"start": 2.9, "end": 4.0, "text": "First line", "speaker": "Speaker 1"},
            {"start": 65.0, "end": 67.0, "text": "Second line"},
        ]
        self.assertEqual(
            transcribe_subtitles.render_srt(segments),
            "1\n00:00:02,900 --> 00:00:04,000\nFirst line\n\n"
            "2\n00:01:05,000 --> 00:01:07,000\nSecond line\n",
        )
        self.assertEqual(
            transcribe_subtitles.render_plain_text(segments),
            "Speaker 1: First line\nSecond line\n",
        )
        self.assertEqual(
            transcribe_subtitles.render_timed_text(segments),
            "[00:02] Speaker 1: First line\n[01:05] Second line\n",
        )

    def test_write_artifacts_records_source_and_speakers(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            source = {"kind": "whisper", "transcription_model": "whisper-base"}
            speaker_meta = {"enabled": True, "source": "pyannote/speaker-diarization-3.1", "speaker_count": 1}
            transcribe_subtitles.write_artifacts(
                output_dir,
                "sample",
                [{"start": 0.0, "end": 1.5, "text": "Hello", "speaker": "Speaker 1"}],
                source,
                speaker_meta,
            )
            payload = json.loads(
                (output_dir / "sample_transcript_segments.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["schemaVersion"], transcribe_subtitles.SCHEMA_VERSION)
            self.assertEqual(payload["source"]["kind"], "whisper")
            self.assertEqual(payload["speakerLabelling"]["speaker_count"], 1)
            self.assertEqual(payload["durationSec"], 1.5)
            self.assertEqual(payload["segments"][0]["speaker"], "Speaker 1")

    def test_main_reuses_complete_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            write_complete_artifacts(output_dir, "sample")
            result = transcribe_subtitles.main(
                ["--video-id", "sample", "--out-dir", str(output_dir), "--mode", "whisper"]
            )
            self.assertEqual(result, 0)
            report = json.loads(
                (output_dir / "subtitle-recognition-report.json").read_text(encoding="utf-8")
            )
            self.assertEqual(report["status"], "reused")
            self.assertEqual(report["source"]["kind"], "existing_artifacts_origin_unknown")

    def test_main_refuses_reused_artifacts_from_a_different_source(self):
        """--mode youtube 不能复用本地识别产物，--mode whisper 不能复用现成字幕。"""
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            write_complete_artifacts(output_dir, "sample")
            (output_dir / "subtitle-recognition-report.json").write_text(
                json.dumps({"mode": "whisper", "source": {"kind": "whisper"}}),
                encoding="utf-8",
            )
            result = transcribe_subtitles.main(
                ["--video-id", "sample", "--out-dir", str(output_dir), "--mode", "youtube"]
            )
            self.assertEqual(result, 1)

            with tempfile.TemporaryDirectory() as other:
                other_dir = Path(other)
                write_complete_artifacts(other_dir, "sample")
                (other_dir / "subtitle-recognition-report.json").write_text(
                    json.dumps({"mode": "youtube", "source": {"kind": "youtube_manual_captions"}}),
                    encoding="utf-8",
                )
                reuse = transcribe_subtitles.main(
                    ["--video-id", "sample", "--out-dir", str(other_dir), "--mode", "whisper"]
                )
                self.assertEqual(reuse, 1)

    def test_main_reuses_matching_source_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            write_complete_artifacts(output_dir, "sample")
            (output_dir / "subtitle-recognition-report.json").write_text(
                json.dumps({"mode": "youtube", "source": {"kind": "youtube_manual_captions"}}),
                encoding="utf-8",
            )
            result = transcribe_subtitles.main(
                ["--video-id", "sample", "--out-dir", str(output_dir), "--mode", "youtube"]
            )
            self.assertEqual(result, 0)
            report = json.loads(
                (output_dir / "subtitle-recognition-report.json").read_text(encoding="utf-8")
            )
            self.assertEqual(report["source"]["kind"], "youtube_manual_captions")
            self.assertEqual(report["reused_source_mode"], "youtube")

    def test_main_refuses_partial_artifacts_without_force(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            (output_dir / "sample_transcript.txt").write_text("已有文本\n", encoding="utf-8")
            result = transcribe_subtitles.main(
                ["--video-id", "sample", "--out-dir", str(output_dir), "--mode", "whisper"]
            )
            self.assertEqual(result, 1)
            self.assertFalse((output_dir / "subtitle-recognition-report.json").exists())

    def test_main_fails_without_any_source(self):
        with tempfile.TemporaryDirectory() as directory:
            result = transcribe_subtitles.main(["--out-dir", directory])
            self.assertEqual(result, 1)

    def test_download_audio_rejects_local_path_and_plain_string(self):
        with tempfile.TemporaryDirectory() as directory:
            local_file = Path(directory) / "clip.mp4"
            local_file.write_bytes(b"stub")
            with self.assertRaises(ValueError) as local_error:
                transcribe_subtitles.download_audio(str(local_file), Path(directory), "clip")
            self.assertIn("--media", str(local_error.exception))
            with self.assertRaises(ValueError):
                transcribe_subtitles.download_audio("not-a-url", Path(directory), "clip")


if __name__ == "__main__":
    unittest.main()
