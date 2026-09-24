"""把 12 段分镜视频合成为一条可连续观看的成片。

事实说明：12 格分镜在原始分镜表里的画幅比例本来就不同（1:1 / 4:3 / 3:2 / 16:9），
因此这里不裁剪任何画面内容，统一等比缩放后居中放在 1920x1080 深灰底上，
再按 P01→P12 顺序拼接并保留 H3 原生音频。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

FFMPEG = r"D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"

ROOT = Path(__file__).resolve().parent
SRC_DIR = ROOT / "out_final"
WORK_DIR = ROOT / "stitch_work"
OUTPUT = ROOT / "out_final" / "storyboard_full.mp4"


def run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败：{' '.join(args)}\n{result.stderr[-3000:]}")


def main() -> None:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    normalized: list[Path] = []
    for index in range(1, 13):
        source = SRC_DIR / f"p{index:02d}.mp4"
        if not source.is_file():
            raise SystemExit(f"缺少分镜视频：{source}")
        target = WORK_DIR / f"n{index:02d}.mp4"
        run(
            [
                FFMPEG,
                "-v",
                "error",
                "-i",
                str(source),
                "-vf",
                "scale=1920:1080:force_original_aspect_ratio=decrease,"
                "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x101014,fps=24,format=yuv420p",
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-y",
                str(target),
            ]
        )
        normalized.append(target)
        print(f"[norm] {source.name} -> {target.name}", flush=True)

    concat_list = WORK_DIR / "concat.txt"
    concat_list.write_text(
        "\n".join(f"file '{path.as_posix()}'" for path in normalized) + "\n",
        encoding="utf-8",
    )
    run(
        [
            FFMPEG,
            "-v",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            # 各段时基不一致时 `-c copy` 会写出错误的 r_frame_rate 元数据（实测出现 120/1），
            # 因此这里统一重新编码为稳定的 24fps / yuv420p 输出。
            "-vf",
            "fps=24,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-y",
            str(OUTPUT),
        ]
    )
    print(f"[concat] {OUTPUT}", flush=True)


if __name__ == "__main__":
    main()
