#!/usr/bin/env python3
"""验证 See-through 完整人物拆分是否包含可用的下半身部件。"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final

from PIL import Image

LOWER_BODY_TAGS: Final[tuple[str, ...]] = ("bottomwear", "legwear", "footwear")
LOWER_TRUNK_TAGS: Final[tuple[str, ...]] = ("bottomwear", "legwear")
ALPHA_THRESHOLD: Final[int] = 10


@dataclass(frozen=True)
class AlphaBounds:
    left: int
    top: int
    right: int
    bottom: int
    opaque_pixels: int


def get_alpha_bounds(path: Path) -> AlphaBounds | None:
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        alpha = rgba.getchannel("A")
        width, height = alpha.size
        pixels = alpha.load()
        left = width
        top = height
        right = -1
        bottom = -1
        opaque_pixels = 0
        for y in range(height):
            for x in range(width):
                if pixels[x, y] <= ALPHA_THRESHOLD:
                    continue
                opaque_pixels += 1
                left = min(left, x)
                top = min(top, y)
                right = max(right, x)
                bottom = max(bottom, y)
    if opaque_pixels == 0:
        return None
    return AlphaBounds(left, top, right, bottom, opaque_pixels)


def read_parts(result_dir: Path) -> dict[str, object]:
    info_path = result_dir / "optimized" / "info.json"
    with info_path.open(encoding="utf-8") as file:
        document: object = json.load(file)
    if not isinstance(document, dict):
        raise ValueError("optimized/info.json 必须是对象")
    parts = document.get("parts")
    if not isinstance(parts, dict):
        raise ValueError("optimized/info.json 缺少 parts 对象")
    frame_size = document.get("frame_size")
    if not isinstance(frame_size, list) or len(frame_size) != 2:
        raise ValueError("optimized/info.json 缺少 frame_size")
    return parts


def validate(result_dir: Path) -> dict[str, object]:
    source_path = result_dir / "src_img.png"
    if not source_path.is_file():
        raise ValueError("缺少 src_img.png")
    source_bounds = get_alpha_bounds(source_path)
    if source_bounds is None:
        raise ValueError("src_img.png 没有不透明角色像素")
    parts = read_parts(result_dir)
    raw_bounds: dict[str, AlphaBounds | None] = {}
    optimized_bounds: dict[str, AlphaBounds | None] = {}
    for tag in LOWER_BODY_TAGS:
        raw_bounds[tag] = get_alpha_bounds(result_dir / f"{tag}.png")
        optimized_path = result_dir / "optimized" / f"{tag}.png"
        optimized_bounds[tag] = get_alpha_bounds(optimized_path) if optimized_path.is_file() else None

    expected_lower_bottom = source_bounds.top + round((source_bounds.bottom - source_bounds.top) * 0.8)
    usable_tags = [
        tag
        for tag in LOWER_TRUNK_TAGS
        if raw_bounds[tag] is not None and raw_bounds[tag].bottom >= expected_lower_bottom
    ]
    optimized_tags = [tag for tag in LOWER_TRUNK_TAGS if tag in parts and optimized_bounds[tag] is not None]
    diagnostics = {
        "resultDir": str(result_dir),
        "sourceBounds": asdict(source_bounds),
        "requiredLowerBottom": expected_lower_bottom,
        "rawLowerBodyBounds": {tag: asdict(bounds) if bounds else None for tag, bounds in raw_bounds.items()},
        "optimizedLowerBodyBounds": {tag: asdict(bounds) if bounds else None for tag, bounds in optimized_bounds.items()},
        "optimizedParts": sorted(parts),
        "usableRawLowerBodyTags": usable_tags,
        "usableOptimizedLowerBodyTags": optimized_tags,
    }
    if not usable_tags:
        raise ValueError(json.dumps({**diagnostics, "error": "原始下装或腿部图层为空或未覆盖角色下部；鞋部图层不能替代可动画的腿部资产"}, ensure_ascii=False))
    if not optimized_tags:
        raise ValueError(json.dumps({**diagnostics, "error": "最终 optimized 目录没有可用的下装或腿部部件；鞋部图层不能替代可动画的腿部资产"}, ensure_ascii=False))
    return diagnostics


def main() -> int:
    parser = argparse.ArgumentParser(description="验证 See-through 完整人物拆分")
    parser.add_argument("--result-dir", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        diagnostics = validate(args.result_dir)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        message = str(error)
        if args.json:
            print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        else:
            print(f"拆分验收失败：{message}")
        return 1
    if args.json:
        print(json.dumps({"ok": True, **diagnostics}, ensure_ascii=False))
    else:
        print("拆分验收通过：检测到可用下半身部件 " + ", ".join(diagnostics["usableOptimizedLowerBodyTags"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
