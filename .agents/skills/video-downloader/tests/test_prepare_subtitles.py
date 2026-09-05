from __future__ import annotations

import importlib.util
import json
import importlib
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_subtitles.py"
SPEC = importlib.util.spec_from_file_location("prepare_subtitles", SCRIPT)
prepare_subtitles = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(prepare_subtitles)


class PrepareSubtitlesTests(unittest.TestCase):
    def test_direct_skill_script_exposes_project_services(self):
        self.assertIn(str(prepare_subtitles.PROJECT_ROOT), prepare_subtitles.sys.path)
        self.assertTrue(hasattr(importlib.import_module("app.service.audio_service"), "audio_service"))

    def test_extract_youtube_video_id(self):
        self.assertEqual(prepare_subtitles.extract_youtube_video_id("https://youtu.be/BaW_jenozKc"), "BaW_jenozKc")
        self.assertEqual(
            prepare_subtitles.extract_youtube_video_id("https://www.youtube.com/shorts/BaW_jenozKc"),
            "BaW_jenozKc",
        )
        self.assertEqual(prepare_subtitles.extract_youtube_video_id("https://example.com/video"), "")

    def test_write_transcript_files_for_youtube_source(self):
        segments = [
            {"start": 2.9, "end": 4.0, "text": "First line"},
            {"start": 65.0, "end": 67.0, "text": "Second line"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            files = prepare_subtitles.write_transcript_files(
                Path(directory),
                "BaW_jenozKc",
                segments,
                source="youtube_transcript_api",
                with_speakers=True,
            )
            self.assertEqual(Path(files["transcript"]).read_text(encoding="utf-8"), "First line\nSecond line\n")
            self.assertEqual(
                Path(files["source_subtitles"]).read_text(encoding="utf-8"),
                "[00:02] First line\n[01:05] Second line\n",
            )

    def test_write_transcript_files_preserves_model_speaker_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            files = prepare_subtitles.write_transcript_files(
                Path(directory),
                "sample",
                [{"start": 0.0, "end": 1.0, "text": "Ignored when labels are supplied"}],
                source="whisper",
                with_speakers=True,
                speaker_lines=["Speaker 2: Model-labelled line"],
            )
            self.assertEqual(
                Path(files["transcript"]).read_text(encoding="utf-8"),
                "Speaker 2: Model-labelled line\n",
            )

    def test_prepare_diarization_audio_reuses_wav(self):
        with tempfile.TemporaryDirectory() as directory:
            media_path = Path(directory) / "source.wav"
            media_path.write_bytes(b"wave-data")
            self.assertEqual(
                prepare_subtitles.prepare_diarization_audio(media_path, Path(directory), "source"),
                media_path,
            )

    def test_main_reuses_existing_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            transcript = output_dir / "manual_transcript.txt"
            transcript.write_text("Reusable transcript\n", encoding="utf-8")
            result = prepare_subtitles.main(["--video-id", "manual", "--out-dir", str(output_dir)])
            self.assertEqual(result, 0)
            report = json.loads((output_dir / "subtitle-preparation-report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "reused")
            self.assertEqual(report["source"], "existing_transcript")


if __name__ == "__main__":
    unittest.main()
