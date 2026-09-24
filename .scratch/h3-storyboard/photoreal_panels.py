"""把 12 格「已去标注」的分镜转换成写实电影首帧。

背景：这张分镜表是铅笔稿。直接把铅笔稿当首帧喂给 H3，模型会把铅笔线稿风格一起
沿用下来，导致 12 段视频风格不统一（有的像实拍、有的还是手绘）。分镜文案本身描述的
是实拍镜头语言（航拍俯冲、超低角度侧拍、跟拍等），所以统一转换到写实风格再生成视频。

每格保持原构图、主体姿态、车型配色与背景布局不变，只替换材质与光照表现。
"""

from __future__ import annotations

from pathlib import Path

from qwen_edit_client import edit_image

ROOT = Path(__file__).resolve().parent
SRC_DIR = ROOT / "panels_clean"
OUT_DIR = ROOT / "panels_photoreal"

PROMPT = (
    "Convert this pencil storyboard sketch into a photorealistic cinematic live-action film still. "
    "Keep the exact same subject, rider, motorcycle design, pose, lean angle, composition, camera angle, "
    "background layout and colour scheme. Render it as real photographic footage: realistic metal, rubber, "
    "leather, concrete and asphalt materials with natural cinematic lighting, accurate reflections and "
    "motion blur where the subject is moving. Absolutely no pencil lines, no hatching, no drawing texture, "
    "no sketch shading, no text, no watermark and no added objects."
)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for index in range(1, 13):
        source = SRC_DIR / f"p{index:02d}.png"
        if not source.is_file():
            raise SystemExit(f"缺少已去标注的分镜：{source}")
        target = OUT_DIR / f"p{index:02d}.png"
        if target.is_file():
            print(f"[skip] p{index:02d} 已存在", flush=True)
            continue
        edit_image(
            source,
            PROMPT,
            target,
            seed=70260921 + index,
            filename_prefix=f"video/tapcanvas-sb-pr-p{index:02d}",
        )
        print(f"[photoreal] p{index:02d} -> {target.name}", flush=True)


if __name__ == "__main__":
    main()
