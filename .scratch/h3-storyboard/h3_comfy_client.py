"""本地 ComfyUI MiniMax H3 视频生成的最小提交/轮询客户端。

只做三件真实的事：
1. 把参考图上传到 ComfyUI（POST /upload/image）
2. 提交 MiniMax H3 Easy 工作流（POST /prompt）
3. 轮询历史并下载产出视频（GET /history/:id -> GET /view）

任何环节失败都直接抛错，不做静默兜底或降级。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BASE_URL = "http://127.0.0.1:8188"
POLL_INTERVAL_SECONDS = 5.0


class ComfyUiError(RuntimeError):
    pass


@dataclass(frozen=True)
class H3VideoRequest:
    prompt: str
    reference_image: Path | None
    mode: str
    aspect_ratio: str
    resolution: str
    seconds: float
    fps: float
    ref_image_size: str
    filename_prefix: str
    keyframe_role: str = "first"
    fl2va_model: str = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    text_encoder: str = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
    video_vae: str = "minimax_h3_video_vae_fp16.safetensors"
    audio_vae: str = "minimax_h3_audio_vae_fp32.safetensors"


def _request(method: str, path: str, *, payload: dict[str, Any] | None = None, timeout: float = 120.0) -> bytes:
    url = f"{BASE_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"} if payload is not None else {"Accept": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise ComfyUiError(f"{method} {path} -> HTTP {error.code}: {detail[:1200]}") from error
    except urllib.error.URLError as error:
        raise ComfyUiError(f"{method} {path} -> 连接失败: {error.reason}") from error


def upload_image(path: Path) -> str:
    """上传参考图，返回 ComfyUI input 目录中的文件名。"""
    boundary = f"----h3{uuid.uuid4().hex}"
    body = bytearray()
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="image"; filename="{path.name}"\r\n'.encode()
    body += b"Content-Type: image/png\r\n\r\n"
    body += path.read_bytes()
    body += b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{BASE_URL}/upload/image",
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ComfyUiError(f"上传参考图失败 HTTP {error.code}: {error.read().decode('utf-8', 'replace')[:600]}") from error
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ComfyUiError(f"上传参考图返回异常：{payload}")
    subfolder = str(payload.get("subfolder") or "").strip()
    return f"{subfolder}/{name}" if subfolder else name


def build_workflow(request: H3VideoRequest, uploaded_name: str | None) -> dict[str, Any]:
    media_state = {
        "images": [{"filename": uploaded_name}] if uploaded_name else [],
        "audios": [],
        "videos": [],
    }
    prompt = request.prompt
    if uploaded_name:
        prompt = prompt.replace("__REF_IMAGE__", "<Picture 1>")
    return {
        "1": {
            "class_type": "MiniMaxH3EasyLoader",
            "inputs": {
                "fl2va_model": request.fl2va_model,
                "ref2va_model": "无",
                "text_encoder": request.text_encoder,
                "video_vae": request.video_vae,
                "audio_vae": request.audio_vae,
            },
        },
        "3": {
            "class_type": "MiniMaxH3Easy",
            "inputs": {
                "h3_bundle": ["1", 0],
                "mode": request.mode,
                "prompt": prompt,
                "resolution": request.resolution,
                "aspect_ratio": request.aspect_ratio,
                "width": 1344,
                "height": 768,
                "seconds": request.seconds,
                "advanced": True,
                "fps": request.fps,
                "keyframe_role": request.keyframe_role,
                "ref_image_size": request.ref_image_size,
                "reference_mention_mode": "index",
                "prompt_optimizer_settings": False,
                "prompt_optimizer_scene_guide": "none",
                "media": ["42", 0],
            },
        },
        "4": {"class_type": "MiniMaxH3EasyOutput", "inputs": {"h3_context": ["3", 1]}},
        "6": {"class_type": "ModelAttentionBackend", "inputs": {"attention": "comfy kitchen attention", "model": ["3", 0]}},
        "24": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "lora_name": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
                "strength_model": 1,
                "model": ["6", 0],
            },
        },
        "7": {"class_type": "BasicGuider", "inputs": {"model": ["24", 0], "conditioning": ["4", 0]}},
        "8": {"class_type": "BasicScheduler", "inputs": {"scheduler": "beta", "steps": 8, "denoise": 1, "model": ["24", 0]}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": int.from_bytes(uuid.uuid4().bytes[:7], "big")}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "11": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["9", 0],
                "guider": ["7", 0],
                "sampler": ["10", 0],
                "sigmas": ["8", 0],
                "latent_image": ["34", 0],
            },
        },
        "13": {"class_type": "ModelAttentionBackend", "inputs": {"attention": "comfy kitchen attention", "model": ["31", 0]}},
        "14": {"class_type": "BasicGuider", "inputs": {"model": ["40", 0], "conditioning": ["38", 0]}},
        "15": {"class_type": "BasicScheduler", "inputs": {"scheduler": "beta", "steps": 3, "denoise": 0.25, "model": ["40", 0]}},
        "16": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "17": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["9", 0],
                "guider": ["14", 0],
                "sampler": ["16", 0],
                "sigmas": ["15", 0],
                "latent_image": ["41", 0],
            },
        },
        "18": {"class_type": "VAEDecode", "inputs": {"samples": ["17", 0], "vae": ["4", 2]}},
        "20": {
            "class_type": "CreateVideo",
            "inputs": {"fps": ["4", 4], "bit_depth": 8, "color_space": "sRGB", "images": ["18", 0], "audio": ["26", 0]},
        },
        "21": {
            "class_type": "SaveVideo",
            "inputs": {
                "filename_prefix": request.filename_prefix,
                "format": "auto",
                "format.codec": "auto",
                "codec": "auto",
                "video": ["20", 0],
            },
        },
        "25": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["4", 2]}},
        "26": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 1], "vae": ["4", 3]}},
        "27": {
            "class_type": "ImageResizeKJv2",
            "inputs": {
                "width": ["32", 0],
                "height": ["32", 1],
                "upscale_method": "lanczos",
                "keep_proportion": "crop",
                "pad_color": "0, 0, 0",
                "crop_position": "center",
                "divisible_by": 32,
                "device": "cpu",
                "image": ["25", 0],
            },
        },
        "28": {"class_type": "VAEEncode", "inputs": {"pixels": ["36", 0], "vae": ["4", 2]}},
        "29": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["11", 1]}},
        "30": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["28", 0], "audio_latent": ["29", 1]}},
        "31": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "32": {"class_type": "ResolutionSelector", "inputs": {"aspect_ratio": ["39", 0], "megapixels": 1, "multiple": 32}},
        "34": {"class_type": "easy clearCacheAll", "inputs": {"anything": ["4", 1]}},
        "35": {"class_type": "easy clearCacheAll", "inputs": {"anything": ["30", 0]}},
        "36": {"class_type": "easy clearCacheAll", "inputs": {"anything": ["27", 0]}},
        "38": {"class_type": "MiniMaxH3EasySecondPassConditioning", "inputs": {"h3_context": ["3", 1], "second_pass_video_latent": ["28", 0]}},
        "39": {"class_type": "MiniMaxH3EasyAspectRatio", "inputs": {"h3_context": ["3", 1]}},
        "40": {
            "class_type": "ModelPreviewOverrideKJ",
            "inputs": {
                "max_resolution": 1024,
                "jpeg_quality": 80,
                "suppress_default_preview": True,
                "preview_frames": ["41", 3],
                "preview_fps": 12,
                "tiny_vae": "none",
                "model": ["13", 0],
            },
        },
        "41": {"class_type": "GetLatentSizeAndCount", "inputs": {"latent": ["35", 0]}},
        "42": {"class_type": "MiniMaxH3EasyMediaLoader", "inputs": {"media_state": json.dumps(media_state, ensure_ascii=False, separators=(",", ":"))}},
    }


def submit(workflow: dict[str, Any]) -> str:
    body = json.dumps({"prompt": workflow, "client_id": f"tapcanvas-h3-{uuid.uuid4().hex[:12]}"}).encode("utf-8")
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
        detail = error.read().decode("utf-8", "replace")
        raise ComfyUiError(f"提交工作流失败 HTTP {error.code}: {detail[:4000]}") from error
    prompt_id = str(payload.get("prompt_id") or "").strip()
    if not prompt_id:
        raise ComfyUiError(f"提交工作流未返回 prompt_id：{payload}")
    return prompt_id


def _extract_comfy_error(history: dict[str, Any]) -> str:
    status = history.get("status") if isinstance(history.get("status"), dict) else {}
    messages = status.get("messages") if isinstance(status.get("messages"), list) else []
    for entry in messages:
        if not isinstance(entry, list) or len(entry) < 2:
            continue
        event, payload = entry[0], entry[1]
        if event != "execution_error" or not isinstance(payload, dict):
            continue
        node_type = str(payload.get("node_type") or "")
        exception_type = str(payload.get("exception_type") or "")
        exception_message = str(payload.get("exception_message") or "")
        reason = ": ".join(part for part in (exception_type, exception_message) if part)
        return f"{node_type} -> {reason}" if node_type else reason
    return json.dumps(history, ensure_ascii=False)[:1500]


def wait_for_video(prompt_id: str, *, timeout_seconds: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        raw = _request("GET", f"/history/{urllib.parse.quote(prompt_id)}", timeout=60)
        payload = json.loads(raw.decode("utf-8")) if raw else {}
        history = payload.get(prompt_id)
        if not isinstance(history, dict):
            time.sleep(POLL_INTERVAL_SECONDS)
            continue
        status = history.get("status") if isinstance(history.get("status"), dict) else {}
        status_str = str(status.get("status_str") or "").lower()
        if status_str in {"error", "failed"}:
            raise ComfyUiError(f"H3 生成失败：{_extract_comfy_error(history)}")
        outputs = history.get("outputs") if isinstance(history.get("outputs"), dict) else {}
        for output in outputs.values():
            if not isinstance(output, dict):
                continue
            videos = output.get("videos") or output.get("gifs") or output.get("images")
            if not isinstance(videos, list):
                continue
            for item in videos:
                if isinstance(item, dict) and str(item.get("filename") or "").lower().endswith(".mp4"):
                    return item
        time.sleep(POLL_INTERVAL_SECONDS)
    raise ComfyUiError(f"H3 生成超时（{timeout_seconds:.0f}s）：{prompt_id}")


def download_video(item: dict[str, Any], target: Path) -> Path:
    query = urllib.parse.urlencode(
        {
            "filename": str(item.get("filename") or ""),
            "subfolder": str(item.get("subfolder") or ""),
            "type": str(item.get("type") or "output"),
        }
    )
    raw = _request("GET", f"/view?{query}", timeout=600)
    if len(raw) < 1024:
        raise ComfyUiError(f"下载到的视频异常小（{len(raw)} bytes）：{item}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    return target

