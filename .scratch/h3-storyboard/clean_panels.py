"""把 12 格分镜统一重绘为「无标注」的干净首帧。

分镜表里每格都叠加了彩色轨迹箭头、细节框与镜头编号；如果直接把带标注的画面
喂给 H3，模型会把箭头和标注当成画面内容复制进视频。这里用本地 Qwen-Image-Edit-2511
逐格抹掉这些标注，同时保持铅笔线条、主体姿态与构图不变。

要求：12 格全部成功。任何一格未产出干净图都会直接报错，不进入后续视频生成。
"""

from __future__ import annotations

from pathlib import Path

from qwen_edit_client import edit_image

ROOT = Path(__file__).resolve().parent
PANEL_DIR = ROOT / "panels"
CLEAN_DIR = ROOT / "panels_clean"

PROMPT = (
    "Remove every annotation overlay from this pencil storyboard drawing: the colored arrows, "
    "arrowheads, colored motion-trajectory lines, colored callout curves, the shot label in the "
    "corner such as P01 or P09, and any diagram markings. Keep the artwork itself completely "
    "unchanged — same subject, same pose, same vehicle, same composition, same pencil linework and "
    "shading. Naturally continue the surrounding pencil shading and background through the areas "
    "where the markings were removed, so the result looks like the original clean drawing with no "
    "trace of any annotation. Do not add new objects, text, watermarks or colors."
)


def main() -> None:
    CLEAN_DIR.mkdir(parents=True, exist_ok=True)
    for index in range(1, 13):
        source = PANEL_DIR / f"p{index:02d}.png"
        if not source.is_file():
            raise SystemExit(f"缺少分镜图：{source}")
        target = CLEAN_DIR / f"p{index:02d}.png"
        if target.is_file():
            print(f"[skip] p{index:02d} 已存在 {target.name}")
            continue
        edit_image(
            source,
            PROMPT,
            target,
            seed=20260921 + index,
            filename_prefix=f"video/tapcanvas-sb-clean-p{index:02d}",
        )
        print(f"[clean] p{index:02d} -> {target.name}")


if __name__ == "__main__":
    main()
