"""串行提交 12 格分镜的 H3 视频生成。

顺序执行的原因：本机是单张 RTX 5070 Ti（17GB），ComfyUI 队列里同时排多个 H3 任务
只会互相抢显存，不会更快，因此这里显式串行，并在每格完成后立即记录耗时。

任一格失败都会立即抛出并保留已完成结果，不跳过、不降级、不伪造。
"""

from __future__ import annotations

import json
import time
import traceback
from pathlib import Path

from h3_comfy_client import H3VideoRequest, build_workflow, download_video, submit, upload_image, wait_for_video

ROOT = Path(__file__).resolve().parent
PANEL_DIR = ROOT / "panels_photoreal"
PROMPT_DIR = ROOT / "prompts"
OUT_DIR = ROOT / "out_final"
REPORT = ROOT / "run_report_final.json"

# 分镜画面与其真实长宽比，保证视频画布与首帧比例一致（避免裁切丢内容）
ASPECT_BY_PANEL: dict[int, str] = {
    1: "1:1",
    2: "4:3",
    3: "4:3",
    4: "3:2",
    5: "16:9",
    6: "4:3",
    7: "4:3",
    8: "3:2",
    9: "16:9",
    10: "3:2",
    11: "3:2",
    12: "16:9",
}


def run_one(index: int, seconds: float = 4.0) -> dict[str, object]:
    panel = PANEL_DIR / f"p{index:02d}.png"
    prompt_file = PROMPT_DIR / f"p{index:02d}.txt"
    if not panel.is_file():
        raise RuntimeError(f"缺少清理后的首帧：{panel}")
    if not prompt_file.is_file():
        raise RuntimeError(f"缺少提示词：{prompt_file}")

    prompt = prompt_file.read_text(encoding="utf-8").strip()
    # H3 节点把 prompt 当纯文本喂给文本编码器（不解析字段名），但契约要求分段结构齐全：
    # 正文 + overall_soundscape + non_diegetic_music，缺任何一段都视为事实不足并显式失败。
    if "\n\noverall_soundscape:" not in prompt or "\n\nnon_diegetic_music:" not in prompt:
        raise RuntimeError(f"提示词缺少 overall_soundscape / non_diegetic_music 段落：{prompt_file}")

    uploaded = upload_image(panel)
    request = H3VideoRequest(
        prompt=prompt,
        reference_image=panel,
        mode="image",
        aspect_ratio=ASPECT_BY_PANEL[index],
        resolution="480P",
        seconds=seconds,
        fps=24.0,
        ref_image_size="1.5k",
        filename_prefix=f"video/tapcanvas-storyboard-p{index:02d}",
    )
    started = time.monotonic()
    prompt_id = submit(build_workflow(request, uploaded))
    item = wait_for_video(prompt_id, timeout_seconds=3600)
    target = download_video(item, OUT_DIR / f"p{index:02d}.mp4")
    elapsed = time.monotonic() - started
    print(f"[done] p{index:02d} {target.name} aspect={ASPECT_BY_PANEL[index]} elapsed={elapsed:.1f}s", flush=True)
    return {
        "panel": index,
        "prompt_id": prompt_id,
        "aspect_ratio": ASPECT_BY_PANEL[index],
        "seconds": seconds,
        "elapsed_seconds": round(elapsed, 1),
        "output": str(target),
        "comfy_source": item,
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, object]] = []
    for index in range(1, 13):
        finish = OUT_DIR / f"p{index:02d}.mp4"
        if finish.is_file() and finish.stat().st_size > 10_000:
            print(f"[skip] p{index:02d} 已存在 {finish.name}", flush=True)
            records.append({"panel": index, "output": str(finish), "skipped": True})
            continue
        try:
            records.append(run_one(index))
        except Exception:
            REPORT.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[fail] p{index:02d}\n{traceback.format_exc()}", flush=True)
            raise
        REPORT.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[all done] {len(records)} 条记录 -> {REPORT}", flush=True)


if __name__ == "__main__":
    main()
