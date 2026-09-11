import json
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

import requests

COMFY_URL = "http://127.0.0.1:8188"
OUTPUT_FILE = Path(r"F:\aigc\aigc\TapCanvas\.scratch\h3-english-witch-12s.flac")
PROMPT = """integrated_multimodal_description:
[Shot 1] A moonlit stone chamber. From 00:00.000 through 00:01.000, a faint cold wind passes through the room; there is no voice, whisper, breath, or other vocal sound. The clip has exactly one speaker: an adult witch (S1). (S1) is always the witch's voice; do not add any other human voice. [Shot 2] At exactly 00:01.000, the witch turns from a candlelit table and begins speaking immediately in a mature female voice: low, smoky, lightly raspy, mysterious, and articulate, never shrill or distorted: <d>[English] The moon remembers every secret buried beneath these stones.</d> [Shot 3] At 00:05.600, she raises one hand over the candle flame and continues in the same calm, spellbinding voice: <d>[English] Step closer, little traveler. I have been expecting you.</d> [Shot 4] At 00:10.000, she falls silent while the candle flame flickers; no additional speech occurs.

overall_soundscape:
Soft cold wind in a stone chamber, a small candle flame flickering, and faint cloth movement. The first second contains only ambience. Apart from the two specified lines, there is no other human voice or vocal sound.

non_diegetic_music:
N/A
"""

def frames_for(duration):
    target = max(5, int(-(-duration * 24 // 1)))
    frames = 5
    while frames < target:
        frames += 17
    return frames

def build_graph(prompt, duration, seed, steps):
    model_inputs = {
        "clip": ["10", 0], "vae": ["11", 0], "audio_vae": ["12", 0],
        "prompt": ["20", 0], "width": 64, "height": 64,
        "length": frames_for(duration), "ref_image_size": "match",
    }
    return {
        "10": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_int4_convrot.safetensors", "type": "minimax", "device": "default"}},
        "11": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "12": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "13": {"class_type": "UNETLoader", "inputs": {"unet_name": "Minimax_H3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "14": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "15": {"class_type": "BasicScheduler", "inputs": {"model": ["19", 0], "scheduler": "beta", "steps": steps, "denoise": 1.0}},
        "16": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "17": {"class_type": "BasicGuider", "inputs": {"model": ["19", 0], "conditioning": ["30", 0]}},
        "18": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["16", 0], "guider": ["17", 0], "sampler": ["14", 0], "sigmas": ["15", 0], "latent_image": ["30", 1]}},
        "19": {"class_type": "TESpeedMiniMaxH3", "inputs": {"model": ["22", 0], "processing_control_value": 0.08, "processing_percent_1": 0.1, "processing_percent_2": 0.9, "mcs": 2, "device": "auto", "mode": "standard"}},
        "20": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": prompt}},
        "21": {"class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch", "inputs": {"model": ["13", 0]}},
        "22": {"class_type": "ModelAttentionBackend", "inputs": {"model": ["21", 0], "attention": "comfy kitchen attention"}},
        "30": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": model_inputs},
        "40": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["18", 0], "vae": ["12", 0]}},
        "41": {"class_type": "PreviewAudio", "inputs": {"audio": ["40", 0]}},
    }

def fresh_graph(graph):
    prefix = uuid.uuid4().hex[:12] + "_"
    result = {}
    for node_id, node in graph.items():
        inputs = {}
        for input_name, value in node["inputs"].items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int):
                inputs[input_name] = [prefix + value[0], value[1]]
            else:
                inputs[input_name] = value
        result[prefix + node_id] = {"class_type": node["class_type"], "inputs": inputs}
    return result

def main():
    graph = fresh_graph(build_graph(PROMPT, 12, time.time_ns() % (2**48), 10))
    submitted = requests.post(COMFY_URL + "/prompt", json={"prompt": graph, "client_id": "tapcanvas-english-witch-test"}, timeout=30)
    submitted.raise_for_status()
    submission = submitted.json()
    prompt_id = submission.get("prompt_id")
    if not prompt_id:
        raise RuntimeError("ComfyUI 拒绝任务：" + json.dumps(submission, ensure_ascii=False))
    deadline = time.time() + 20 * 60
    while time.time() < deadline:
        response = requests.get(COMFY_URL + f"/history/{prompt_id}", timeout=30)
        response.raise_for_status()
        history = response.json().get(prompt_id)
        if history is None:
            time.sleep(3)
            continue
        status = history.get("status", {}).get("status_str")
        if status in {"error", "failed"}:
            raise RuntimeError("ComfyUI 生成失败：" + json.dumps(history.get("messages", []), ensure_ascii=False))
        for output in history.get("outputs", {}).values():
            audios = output.get("audio", [])
            if audios:
                audio = audios[0]
                media = requests.get(COMFY_URL + "/view?" + urlencode({"filename": audio["filename"], "subfolder": audio.get("subfolder", ""), "type": audio.get("type", "temp")}), timeout=120)
                media.raise_for_status()
                OUTPUT_FILE.write_bytes(media.content)
                print(json.dumps({"promptId": prompt_id, "output": str(OUTPUT_FILE), "bytes": OUTPUT_FILE.stat().st_size, "audio": audio}, ensure_ascii=False))
                return
        time.sleep(3)
    raise TimeoutError(f"MiniMax H3 英文测试超时：{prompt_id}")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
