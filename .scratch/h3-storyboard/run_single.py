"""跑单镜 H3 生成，用于验证链路与耗时预算。

用法：py run_single.py <panel 编号> [seconds]
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from h3_comfy_client import H3VideoRequest, build_workflow, download_video, submit, upload_image, wait_for_video

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "out"
CLEAN_DIR = ROOT / "panels_clean"


def main() -> None:
    index = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
    panel = CLEAN_DIR / f"p{index:02d}.png"
    if not panel.is_file():
        raise SystemExit(f"缺少清理后的分镜首帧：{panel}")

    prompt = (ROOT / "prompts" / f"p{index:02d}.txt").read_text(encoding="utf-8").strip()
    uploaded = upload_image(panel)
    print(f"[upload] {panel.name} -> {uploaded}")

    request = H3VideoRequest(
        prompt=prompt,
        reference_image=panel,
        mode="image",
        aspect_ratio="3:2",
        resolution="480P",
        seconds=seconds,
        fps=24.0,
        ref_image_size="1.5k",
        filename_prefix=f"video/tapcanvas-storyboard-p{index:02d}",
    )
    workflow = build_workflow(request, uploaded)
    started = time.monotonic()
    prompt_id = submit(workflow)
    print(f"[submit] prompt_id={prompt_id}")
    item = wait_for_video(prompt_id, timeout_seconds=3600)
    target = download_video(item, OUT_DIR / f"p{index:02d}.mp4")
    elapsed = time.monotonic() - started
    print(f"[done] {target} elapsed={elapsed:.1f}s")


if __name__ == "__main__":
    main()
