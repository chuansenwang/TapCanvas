"""本地 ComfyUI Qwen-Image-Edit-2511 的最小调用客户端。

用途：把分镜表里带铅笔标注（轨迹箭头、细节框）的画面重绘为干净写实首帧，
让 H3 不再把标注当成画面内容复制到视频里。

只包含工作流真实需要的节点，失败即抛错，不做静默兜底。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from h3_comfy_client import ComfyUiError, _request, download_video, upload_image  # noqa: F401  (复用真实上传/下载实现)

BASE_URL = "http://127.0.0.1:8188"
UNET = "qwen_image_edit_2511_fp8mixed.safetensors"
LORA = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
VAE = "qwen_image_vae.safetensors"


def build_edit_workflow(prompt: str, uploaded_name: str, seed: int, filename_prefix: str) -> dict[str, object]:
    return {
        "41": {"class_type": "LoadImage", "inputs": {"image": uploaded_name}},
        "195": {
            "class_type": "SaveImageAdvanced",
            "inputs": {
                "filename_prefix": filename_prefix,
                "format": "png",
                "format.bit_depth": "8-bit",
                "format.input_color_space": "sRGB",
                "images": ["217", 0],
            },
        },
        "196": {"class_type": "ModelSamplingAuraFlow", "inputs": {"shift": 3.1, "model": ["208", 0]}},
        "197": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "198": {
            "class_type": "FluxKontextMultiReferenceLatentMethod",
            "inputs": {"reference_latents_method": "index_timestep_zero", "conditioning": ["200", 0]},
        },
        "199": {
            "class_type": "FluxKontextMultiReferenceLatentMethod",
            "inputs": {"reference_latents_method": "index_timestep_zero", "conditioning": ["202", 0]},
        },
        "200": {
            "class_type": "TextEncodeQwenImageEditPlus",
            "inputs": {"prompt": "", "clip": ["209", 0], "vae": ["197", 0], "image1": ["218", 0]},
        },
        "202": {
            "class_type": "TextEncodeQwenImageEditPlus",
            "inputs": {"prompt": prompt, "clip": ["209", 0], "vae": ["197", 0], "image1": ["218", 0]},
        },
        "203": {"class_type": "CFGNorm", "inputs": {"strength": 1, "pre_cfg": False, "model": ["196", 0]}},
        "204": {"class_type": "LoraLoaderModelOnly", "inputs": {"lora_name": LORA, "strength_model": 1, "model": ["203", 0]}},
        "205": {"class_type": "PrimitiveFloat", "inputs": {"value": 4}},
        "206": {"class_type": "PrimitiveFloat", "inputs": {"value": 1}},
        "207": {"class_type": "VAEEncode", "inputs": {"pixels": ["218", 0], "vae": ["197", 0]}},
        "208": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "209": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "qwen_image", "device": "default"}},
        "210": {"class_type": "ComfySwitchNode", "inputs": {"switch": ["213", 0], "on_false": ["203", 0], "on_true": ["204", 0]}},
        "211": {"class_type": "PrimitiveInt", "inputs": {"value": 4}},
        "212": {"class_type": "PrimitiveInt", "inputs": {"value": 40}},
        "213": {"class_type": "PrimitiveBoolean", "inputs": {"value": True}},
        "214": {"class_type": "ComfySwitchNode", "inputs": {"switch": ["213", 0], "on_false": ["205", 0], "on_true": ["206", 0]}},
        "215": {"class_type": "ComfySwitchNode", "inputs": {"switch": ["213", 0], "on_false": ["212", 0], "on_true": ["211", 0]}},
        "216": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": ["215", 0],
                "cfg": ["214", 0],
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1,
                "model": ["210", 0],
                "positive": ["199", 0],
                "negative": ["198", 0],
                "latent_image": ["207", 0],
            },
        },
        "217": {"class_type": "VAEDecode", "inputs": {"samples": ["216", 0], "vae": ["197", 0]}},
        "218": {"class_type": "FluxKontextImageScale", "inputs": {"image": ["41", 0]}},
    }


def _submit(workflow: dict[str, object]) -> str:
    body = json.dumps({"prompt": workflow, "client_id": f"tapcanvas-qwen-edit-{uuid.uuid4().hex[:12]}"}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/prompt",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ComfyUiError(f"提交 Qwen Edit 工作流失败 HTTP {error.code}: {error.read().decode('utf-8', 'replace')[:4000]}") from error
    prompt_id = str(payload.get("prompt_id") or "").strip()
    if not prompt_id:
        raise ComfyUiError(f"提交 Qwen Edit 工作流未返回 prompt_id：{payload}")
    return prompt_id


def edit_image(source: Path, prompt: str, target: Path, *, seed: int, filename_prefix: str, timeout_seconds: float = 900.0) -> Path:
    uploaded = upload_image(source)
    prompt_id = _submit(build_edit_workflow(prompt, uploaded, seed, filename_prefix))
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        raw = _request("GET", f"/history/{urllib.parse.quote(prompt_id)}", timeout=60)
        payload = json.loads(raw.decode("utf-8")) if raw else {}
        history = payload.get(prompt_id)
        if not isinstance(history, dict):
            time.sleep(3.0)
            continue
        status = history.get("status") if isinstance(history.get("status"), dict) else {}
        status_str = str(status.get("status_str") or "").lower()
        if status_str in {"error", "failed"}:
            messages = status.get("messages") if isinstance(status.get("messages"), list) else []
            detail = json.dumps(messages, ensure_ascii=False)[:1500]
            raise ComfyUiError(f"Qwen Edit 生成失败：{detail}")
        outputs = history.get("outputs") if isinstance(history.get("outputs"), dict) else {}
        for output in outputs.values():
            if not isinstance(output, dict):
                continue
            images = output.get("images")
            if not isinstance(images, list):
                continue
            for item in images:
                if isinstance(item, dict) and str(item.get("filename") or "").lower().endswith(".png"):
                    download_video(item, target)
                    return target
        time.sleep(3.0)
    raise ComfyUiError(f"Qwen Edit 生成超时（{timeout_seconds:.0f}s）：{prompt_id}")

