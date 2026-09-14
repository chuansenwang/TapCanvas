#!/usr/bin/env python3
"""从完整角色透明图中提取真实的人体语义下装、腿部与鞋部遮罩。"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final

import numpy as np
import torch
from PIL import Image


PART_INDEX: Final[dict[str, int]] = {
    "bottomwear": 13,
    "legwear": 14,
    "footwear": 15,
}


@dataclass(frozen=True)
class PartMetadata:
    tag: str
    xyxy: list[int]
    opaque_pixels: int
    source: str


def mask_xyxy(mask: np.ndarray) -> list[int] | None:
    ys, xs = np.where(mask)
    if xs.size == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def load_model(checkpoint: Path) -> torch.nn.Module:
    if not checkpoint.is_file():
        raise ValueError(f"找不到人体解析模型：{checkpoint}")

    from modules.semanticsam import SemanticSam
    from utils.torch_utils import init_model_from_pretrained

    return init_model_from_pretrained(
        str(checkpoint),
        SemanticSam,
        download_from_hf=False,
        model_args={"class_num": 19},
    ).to(device="cuda").eval()


def make_part_image(source: np.ndarray, mask: np.ndarray) -> np.ndarray:
    output = source.copy()
    output[..., 3] = np.where(mask, source[..., 3], 0)
    return output


def extract(source_path: Path, output_dir: Path, checkpoint: Path) -> dict[str, object]:
    if output_dir.exists():
        raise ValueError(f"输出目录已存在，拒绝覆盖：{output_dir}")
    if not source_path.is_file():
        raise ValueError(f"找不到源角色图：{source_path}")

    source = np.array(Image.open(source_path).convert("RGBA"))
    source_alpha = source[..., 3] > 10
    model = load_model(checkpoint)
    with torch.inference_mode():
        predictions = model.inference(source[..., :3])[0].detach().float().cpu().numpy()

    output_dir.mkdir(parents=True, exist_ok=False)
    parts: dict[str, PartMetadata] = {}
    for tag, index in PART_INDEX.items():
        semantic_mask = predictions[index] > 0
        mask = semantic_mask & source_alpha
        xyxy = mask_xyxy(mask)
        if xyxy is None:
            continue
        output = make_part_image(source, mask)
        Image.fromarray(output).save(output_dir / f"{tag}.png")
        parts[tag] = PartMetadata(
            tag=tag,
            xyxy=xyxy,
            opaque_pixels=int(mask.sum()),
            source="sam_body_parsing",
        )

    source_copy = output_dir / "src_img.png"
    Image.fromarray(source).save(source_copy)
    metadata: dict[str, object] = {
        "frame_size": [int(source.shape[1]), int(source.shape[0])],
        "source_image": str(source_path),
        "model_checkpoint": str(checkpoint),
        "parts": {tag: asdict(part) for tag, part in parts.items()},
    }
    (output_dir / "semantic-info.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if not any(tag in parts for tag in ("bottomwear", "legwear")):
        raise ValueError("人体解析未产生下装或腿部遮罩")
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description="提取角色下半身语义遮罩")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=Path("F:/aigc/aigc/see-through/models/sam_body_parsing/checkpoint-18000.pt"),
    )
    args = parser.parse_args()
    try:
        metadata = extract(args.source, args.output_dir, args.checkpoint)
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, **metadata}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
