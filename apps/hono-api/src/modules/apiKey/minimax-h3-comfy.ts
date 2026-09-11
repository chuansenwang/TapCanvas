import { randomUUID } from "node:crypto";

import { AppError } from "../../middleware/error";

type JsonRecord = Record<string, unknown>;
type ComfyNode = { class_type: string; inputs: JsonRecord };
type ComfyWorkflow = Record<string, ComfyNode>;

export type MiniMaxH3ComfyAudioInput = {
  baseUrl: string;
  prompt: string;
  duration: number | null;
  steps: number | null | undefined;
  unet: string | null | undefined;
  referenceAudioUrls: readonly string[];
};

type ComfyAudioFile = {
  filename: string;
  subfolder: string;
  type: string;
};

const DEFAULT_STEPS = 10;
const MIN_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 15;
const FRAMES_PER_SECOND = 24;
const FRAME_GRID_STEP = 17;
const COMFY_TIMEOUT_MS = 1_200_000;

const H3_MODEL_NAMES = {
  unet: "Minimax_H3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  clip: "qwen3vl_32b_minimax_h3_int4_convrot.safetensors",
  videoVae: "minimax_h3_video_vae_fp16.safetensors",
  audioVae: "minimax_h3_audio_vae_fp32.safetensors",
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function comfyUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function readComfyError(payload: unknown): string {
  try {
    return JSON.stringify(payload).slice(0, 800);
  } catch {
    return String(payload).slice(0, 800);
  }
}

function enumValues(node: JsonRecord, inputName: string): string[] {
  const input = isRecord(node.input) ? node.input : null;
  const required = input && isRecord(input.required) ? input.required : null;
  const definition = required?.[inputName];
  if (!Array.isArray(definition) || !Array.isArray(definition[0])) return [];
  return definition[0].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}

async function validateH3Models(baseUrl: string): Promise<void> {
  const endpoint = comfyUrl(baseUrl, "object_info");
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new AppError(`ComfyUI 模型枚举查询连接失败：${cause}`, { status: 502, code: "minimax_h3_model_catalog_failed", details: { endpoint, cause } });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload)) throw new AppError(`ComfyUI 模型枚举查询失败：${response.status}`, { status: 502, code: "minimax_h3_model_catalog_failed", details: { endpoint, response: payload } });
  const required = [
    { node: "UNETLoader", input: "unet_name", expected: H3_MODEL_NAMES.unet },
    { node: "CLIPLoader", input: "clip_name", expected: H3_MODEL_NAMES.clip },
    { node: "VAELoader", input: "vae_name", expected: H3_MODEL_NAMES.videoVae },
    { node: "VAELoader", input: "vae_name", expected: H3_MODEL_NAMES.audioVae },
  ];
  for (const requirement of required) {
    const node = payload[requirement.node];
    const values = isRecord(node) ? enumValues(node, requirement.input) : [];
    if (!values.includes(requirement.expected)) {
      throw new AppError(`ComfyUI 未登记 H3 模型：${requirement.expected}`, { status: 503, code: "minimax_h3_model_unavailable", details: { endpoint, node: requirement.node, input: requirement.input, expected: requirement.expected, available: values } });
    }
  }
}

function estimateDurationSeconds(prompt: string): number {
  const dialogueTexts = Array.from(prompt.matchAll(/<d>\s*\[[^\]]+\]\s*([\s\S]*?)\s*<\/d>/gu), (match) => match[1]!.replace(/\s/gu, ""));
  const speechSeconds = dialogueTexts.reduce((sum, text) => sum + text.length / 4.5, 0);
  const dialogueBudget = 1 + speechSeconds + Math.max(0, dialogueTexts.length - 1) * 0.6 + 1.5;
  const timestamps = Array.from(prompt.matchAll(/At\s+(\d{1,2}):(\d{2}\.\d{3})/gu), (match) => Number(match[1]) * 60 + Number(match[2]));
  const timelineBudget = timestamps.length && dialogueTexts.length
    ? Math.max(...timestamps) + Math.max(1.5, dialogueTexts.at(-1)!.length / 4.5) + 1.5
    : 0;
  return Math.max(MIN_DURATION_SECONDS, dialogueBudget, timelineBudget);
}

function resolveDurationSeconds(requestedDuration: number | null, prompt: string): number {
  return requestedDuration ?? estimateDurationSeconds(prompt);
}

function framesForDuration(duration: number): number {
  const target = Math.max(MIN_DURATION_SECONDS * FRAMES_PER_SECOND, Math.ceil(duration * FRAMES_PER_SECOND));
  let frames = 5;
  while (frames < target) frames += FRAME_GRID_STEP;
  return frames;
}

function freshWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
  const prefix = `${randomUUID().replace(/-/gu, "").slice(0, 12)}_`;
  const fresh: ComfyWorkflow = {};
  for (const [nodeId, node] of Object.entries(workflow)) {
    const inputs: JsonRecord = {};
    for (const [name, value] of Object.entries(node.inputs)) {
      inputs[name] = Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number"
        ? [prefix + value[0], value[1]]
        : value;
    }
    fresh[prefix + nodeId] = { class_type: node.class_type, inputs };
  }
  return fresh;
}

function buildWorkflow(input: { prompt: string; duration: number; steps: number; referenceFiles: readonly string[] }): ComfyWorkflow {
  const modelInputs: JsonRecord = {
    clip: ["10", 0],
    vae: ["11", 0],
    audio_vae: ["12", 0],
    prompt: ["20", 0],
    width: 64,
    height: 64,
    length: framesForDuration(input.duration),
    ref_image_size: "match",
  };
  const workflow: ComfyWorkflow = {
    "10": { class_type: "CLIPLoader", inputs: { clip_name: H3_MODEL_NAMES.clip, type: "minimax", device: "default" } },
    "11": { class_type: "VAELoader", inputs: { vae_name: H3_MODEL_NAMES.videoVae } },
    "12": { class_type: "VAELoader", inputs: { vae_name: H3_MODEL_NAMES.audioVae } },
    "13": { class_type: "UNETLoader", inputs: { unet_name: H3_MODEL_NAMES.unet, weight_dtype: "default" } },
    "14": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "15": { class_type: "BasicScheduler", inputs: { model: ["19", 0], scheduler: "beta", steps: input.steps, denoise: 1 } },
    "16": { class_type: "RandomNoise", inputs: { noise_seed: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) } },
    "17": { class_type: "BasicGuider", inputs: { model: ["19", 0], conditioning: ["30", 0] } },
    "18": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["16", 0], guider: ["17", 0], sampler: ["14", 0], sigmas: ["15", 0], latent_image: ["30", 1] } },
    "19": { class_type: "TESpeedMiniMaxH3", inputs: { model: ["22", 0], processing_control_value: 0.08, processing_percent_1: 0.1, processing_percent_2: 0.9, mcs: 2, device: "auto", mode: "standard" } },
    "20": { class_type: "PrimitiveStringMultiline", inputs: { value: input.prompt } },
    "21": { class_type: "MiniMaxH3MemoryEfficientSageAttentionPatch", inputs: { model: ["13", 0] } },
    "22": { class_type: "ModelAttentionBackend", inputs: { model: ["21", 0], attention: "comfy kitchen attention" } },
    "30": { class_type: "MiniMaxH3ReferenceToVideo", inputs: modelInputs },
    "40": { class_type: "VAEDecodeAudio", inputs: { samples: ["18", 0], vae: ["12", 0] } },
    "41": { class_type: "PreviewAudio", inputs: { audio: ["40", 0] } },
  };
  for (const [index, filename] of input.referenceFiles.entries()) {
    const nodeId = `5${index}`;
    workflow[nodeId] = { class_type: "LoadAudio", inputs: { audio: filename } };
    modelInputs[`ref_audios.ref_audio_${index}`] = [nodeId, 0];
  }
  return freshWorkflow(workflow);
}

function extensionFromContentType(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("flac")) return "flac";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("m4a") || contentType.includes("mp4")) return "m4a";
  return "mp3";
}

async function uploadReferenceAudio(baseUrl: string, url: string, index: number): Promise<string> {
  let source: Response;
  try {
    source = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new AppError(`H3 参考音频下载连接失败：${cause}`, { status: 502, code: "minimax_h3_reference_fetch_failed", details: { url, cause } });
  }
  if (!source.ok) throw new AppError(`H3 参考音频下载失败：${source.status}`, { status: 502, code: "minimax_h3_reference_fetch_failed", details: { url } });
  const blob = await source.blob();
  const contentType = source.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || blob.type.toLowerCase() || "audio/wav";
  const form = new FormData();
  form.append("image", blob, `tapcanvas-h3-ref-${randomUUID()}-${index + 1}.${extensionFromContentType(contentType)}`);
  const endpoint = comfyUrl(baseUrl, "upload/image");
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new AppError(`ComfyUI 参考音频上传连接失败：${cause}`, { status: 502, code: "minimax_h3_reference_upload_failed", details: { endpoint, cause } });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || !readText(payload.name)) {
    throw new AppError(`ComfyUI 参考音频上传失败：${response.status}`, { status: 502, code: "minimax_h3_reference_upload_failed", details: { endpoint, response: payload } });
  }
  return readText(payload.name);
}

async function waitForOutput(baseUrl: string, promptId: string): Promise<ComfyAudioFile> {
  const deadline = Date.now() + COMFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const endpoint = comfyUrl(baseUrl, `history/${encodeURIComponent(promptId)}`);
    let response: Response;
    try {
      response = await fetch(endpoint, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new AppError(`ComfyUI 历史查询连接失败：${cause}`, { status: 502, code: "minimax_h3_history_failed", details: { endpoint, promptId, cause } });
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload)) throw new AppError(`ComfyUI 历史查询失败：${response.status}`, { status: 502, code: "minimax_h3_history_failed", details: { endpoint, promptId, response: payload } });
    const history = payload[promptId];
    if (!isRecord(history)) { await new Promise<void>((resolve) => setTimeout(resolve, 3_000)); continue; }
    const status = isRecord(history.status) ? readText(history.status.status_str).toLowerCase() : "";
    if (status === "error" || status === "failed") throw new AppError(`MiniMax H3 生成失败：${readComfyError(history.messages)}`, { status: 502, code: "minimax_h3_generation_failed", details: { promptId, history } });
    const outputs = isRecord(history.outputs) ? history.outputs : {};
    for (const output of Object.values(outputs)) {
      if (!isRecord(output) || !Array.isArray(output.audio)) continue;
      const candidate = output.audio.find((item): item is JsonRecord => isRecord(item) && Boolean(readText(item.filename)));
      if (candidate) return { filename: readText(candidate.filename), subfolder: readText(candidate.subfolder), type: readText(candidate.type) || "temp" };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
  }
  throw new AppError(`MiniMax H3 生成超时：${promptId}`, { status: 504, code: "minimax_h3_timeout", details: { promptId, timeoutMs: COMFY_TIMEOUT_MS } });
}

function replaceNumberedReferenceAliases(prompt: string, count: number): string {
  let result = prompt;
  for (let index = 0; index < count; index += 1) result = result.replaceAll(`@${index + 1}`, `<Audio ${index + 1}>`);
  return result;
}

export async function generateMiniMaxH3AudioWithComfy(input: MiniMaxH3ComfyAudioInput): Promise<{ audio: Buffer; selectedDuration: number; promptId: string }> {
  if (input.unet && input.unet !== "fl2va") {
    throw new AppError(`当前 ComfyUI H3 音频工作流仅注册 fl2va；${input.unet} 未在 8188 的实时模型枚举中，未开始生成`, { status: 400, code: "minimax_h3_unet_unavailable", details: { requestedUnet: input.unet, supportedUnet: "fl2va" } });
  }
  const selectedDuration = resolveDurationSeconds(input.duration, input.prompt);
  if (!Number.isFinite(selectedDuration) || selectedDuration < 1 || selectedDuration > MAX_DURATION_SECONDS) {
    throw new AppError(`MiniMax H3 自动估算时长为 ${selectedDuration.toFixed(2)} 秒，超出可执行的 1~15 秒范围；请拆分台词或明确指定 1~15 秒时长`, { status: 400, code: "minimax_h3_audio_duration_unexecutable", details: { selectedDuration, minDuration: 1, maxDuration: MAX_DURATION_SECONDS } });
  }
  await validateH3Models(input.baseUrl);
  const referenceFiles: string[] = [];
  for (const [index, url] of input.referenceAudioUrls.entries()) referenceFiles.push(await uploadReferenceAudio(input.baseUrl, url, index));
  const workflow = buildWorkflow({
    prompt: replaceNumberedReferenceAliases(input.prompt, referenceFiles.length),
    duration: selectedDuration,
    steps: input.steps ?? DEFAULT_STEPS,
    referenceFiles,
  });
  const promptEndpoint = comfyUrl(input.baseUrl, "prompt");
  let response: Response;
  try {
    response = await fetch(promptEndpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: `tapcanvas-h3-${randomUUID()}` }), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new AppError(`ComfyUI H3 提交连接失败：${cause}`, { status: 502, code: "minimax_h3_prompt_failed", details: { endpoint: promptEndpoint, cause } });
  }
  const submitted: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(submitted) || !readText(submitted.prompt_id)) throw new AppError(`ComfyUI H3 提交失败：${response.status}`, { status: 502, code: "minimax_h3_prompt_failed", details: { endpoint: promptEndpoint, response: submitted } });
  const promptId = readText(submitted.prompt_id);
  const file = await waitForOutput(input.baseUrl, promptId);
  const audioEndpoint = comfyUrl(input.baseUrl, `view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder)}&type=${encodeURIComponent(file.type)}`);
  const audioResponse = await fetch(audioEndpoint, { signal: AbortSignal.timeout(120_000) });
  if (!audioResponse.ok) throw new AppError(`ComfyUI 音频下载失败：${audioResponse.status}`, { status: 502, code: "minimax_h3_output_download_failed", details: { endpoint: audioEndpoint, promptId } });
  const audio = Buffer.from(await audioResponse.arrayBuffer());
  if (audio.byteLength < 128) throw new AppError("ComfyUI 返回空音频", { status: 502, code: "minimax_h3_output_empty", details: { promptId } });
  return { audio, selectedDuration, promptId };
}
