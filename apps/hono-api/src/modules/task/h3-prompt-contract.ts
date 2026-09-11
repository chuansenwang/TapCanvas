import type { ComfyMediaInput } from "./comfyui-workflow";

export type H3PromptMode =
  | "text"
  | "first_frame"
  | "last_frame"
  | "first_last_frame"
  | "reference";

function hasField(prompt: string, field: string): boolean {
  return prompt
    .split(/\r?\n/u)
    .some((line) => line.trimStart().startsWith(`${field}:`));
}

export function resolveH3PromptMode(
  mediaInputs: readonly ComfyMediaInput[],
): H3PromptMode {
  const first = mediaInputs.some((item) => item.role === "first_frame");
  const last = mediaInputs.some((item) => item.role === "last_frame");
  if (first && last) return "first_last_frame";
  if (first) return "first_frame";
  if (last) return "last_frame";
  return mediaInputs.length === 0 ? "text" : "reference";
}

export function validateH3PromptContract(input: {
  prompt: string;
  mediaInputs: readonly ComfyMediaInput[];
}): { ok: true; mode: H3PromptMode } | { ok: false; mode: H3PromptMode; missing: string[] } {
  const mode = resolveH3PromptMode(input.mediaInputs);
  const required = mode === "reference"
    ? ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]
    : ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
  const missing = required.filter((field) => !hasField(input.prompt, field));
  return missing.length === 0 ? { ok: true, mode } : { ok: false, mode, missing };
}

/**
 * MiniMax H3 音频接口的结构性合同。这里仅校验段落与时间轴标记，不做语义判断；
 * 角色、音色、台词和声场内容由原生 Agent 按 H3 音频 Skill 负责生成。
 */
export function validateH3AudioPromptContract(input: {
  prompt: string;
  referenceAudioCount: number;
}): { ok: true; mode: "text" | "reference" } | { ok: false; mode: "text" | "reference"; missing: string[] } {
  const mode = input.referenceAudioCount > 0 ? "reference" : "text";
  const required = mode === "reference"
    ? ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]
    : ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
  const missing = required.filter((field) => !hasField(input.prompt, field));
  return missing.length === 0 ? { ok: true, mode } : { ok: false, mode, missing };
}

export function validateH3AudioDuration(duration: number | null | undefined): {
  ok: true;
  duration: number | null;
} | {
  ok: false;
  reason: string;
} {
  if (duration === null || duration === undefined) return { ok: true, duration: null };
  if (!Number.isFinite(duration) || duration < 1) {
    return { ok: false, reason: "MiniMax H3 音频时长必须是不小于 1 秒的有限数字" };
  }
  if (duration > 15) {
    return { ok: false, reason: "MiniMax H3 音频请求时长不得超过 15 秒；超过该训练稳定区间会降低台词遵循度" };
  }
  return { ok: true, duration };
}
