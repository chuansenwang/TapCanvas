"""从 PROMPTS.md 抽出 6 段正式提示词，按整图参考模式逐段提交 H3。

与切图模式的区别：这里 6 段全部使用同一张整张分镜表作为 <Picture 1>，
不裁切、不预处理，由 H3 依据参考图重演各段动作。
"""

from __future__ import annotations

import json
import re
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(r"F:\aigc\aigc\TapCanvas\.scratch\h3-storyboard")))

from h3_comfy_client import (  # noqa: E402
    H3VideoRequest,
    build_workflow,
    download_video,
    submit,
    upload_image,
    wait_for_video,
)

ROOT = Path(__file__).resolve().parent
SHEET = ROOT / "sheet_832.png"
DOC = ROOT / "PROMPTS.md"
OUT_DIR = ROOT / "out"
REPORT = ROOT / "run_report.json"


def parse_units(text: str) -> list[tuple[str, int, str]]:
    """抽出 ## P01｜8秒｜段名｜彩色 下的六字段正文（含固定尾部）。"""
    hits = list(re.finditer(r"(?m)^##\s+(P\d{2})｜(\d{1,2})秒｜[^\n]+$", text))
    if not hits:
        raise SystemExit("PROMPTS.md 中没有找到 P 单元标题")
    units = []
    for index, hit in enumerate(hits):
        stop = hits[index + 1].start() if index + 1 < len(hits) else text.find("\n# 分段检测")
        body = text[hit.end():stop].strip()
        units.append((hit.group(1), int(hit.group(2)), body))
    return units


def validate_body(name: str, body: str) -> None:
    for field in (
        "subject_definitions:",
        "summary:",
        "retention_analysis:",
        "detailed_description:",
        "overall_soundscape:",
        "non_diegetic_music:",
        "[Prohibited items]",
        "[Mandatory declaration]",
    ):
        if body.count(field) != 1:
            raise RuntimeError(f"{name} 的正文缺少或重复字段 {field}")
    if not body.startswith("subject_definitions:"):
        raise RuntimeError(f"{name} 的正文未以 subject_definitions 开头")
    print(f"[check] {name} 字段完整，{len(body)} 字符", flush=True)


def main() -> None:
    if not SHEET.is_file():
        raise SystemExit(f"缺少整图参考：{SHEET}")
    units = parse_units(DOC.read_text(encoding="utf-8"))
    uploaded = upload_image(SHEET)
    print(f"[upload] {SHEET.name} -> {uploaded}（6 段共用同一张整图）", flush=True)

    records: list[dict[str, object]] = []
    for name, seconds, body in units:
        validate_body(name, body)
        target = OUT_DIR / f"{name.lower()}.mp4"
        if target.is_file() and target.stat().st_size > 10_000:
            print(f"[skip] {name} 已存在", flush=True)
            records.append({"unit": name, "output": str(target), "skipped": True})
            continue
        request = H3VideoRequest(
            prompt=body,
            reference_image=None,
            mode="reference",
            aspect_ratio="3:2",
            resolution="480P",
            seconds=float(seconds),
            fps=24.0,
            ref_image_size="1.5k",
            filename_prefix=f"video/tapcanvas-manga-{name.lower()}",
        )
        started = time.monotonic()
        try:
            prompt_id = submit(build_workflow(request, uploaded))
            item = wait_for_video(prompt_id, timeout_seconds=3600)
            download_video(item, target)
        except Exception:
            REPORT.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[fail] {name}\n{traceback.format_exc()}", flush=True)
            raise
        elapsed = time.monotonic() - started
        print(f"[done] {name} {seconds}s -> {target.name} elapsed={elapsed:.1f}s", flush=True)
        records.append(
            {
                "unit": name,
                "seconds": seconds,
                "prompt_id": prompt_id,
                "elapsed_seconds": round(elapsed, 1),
                "output": str(target),
                "comfy_source": item,
            }
        )
        REPORT.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[all done] {len(records)} 段 -> {REPORT}", flush=True)


if __name__ == "__main__":
    main()
