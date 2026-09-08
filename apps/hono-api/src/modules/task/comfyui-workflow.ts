import { AppError } from "../../middleware/error";
import type { AppContext } from "../../types";
import { getPrismaClient } from "../../platform/node/prisma";
import { ensureModelCatalogSchema } from "../model-catalog/model-catalog.repo";
import { TaskAssetSchema, TaskResultSchema, type TaskRequestDto, type TaskResultDto } from "./task.schemas";

type JsonRecord = Record<string, unknown>;
type ComfyNode = { class_type?: unknown; inputs?: JsonRecord };
type ComfyWorkflow = Record<string, ComfyNode>;

export type ComfyMediaInput = {
	type: "image" | "audio" | "video";
	url: string;
	role?: "reference" | "first_frame" | "last_frame" | "audio" | "video";
};

export type UploadedComfyMedia = ComfyMediaInput & { filename: string };

type H3InputMode =
	| "text"
	| "first_frame"
	| "last_frame"
	| "first_last_frame"
	| "reference"
	| "digital_human";

type WorkflowVariant = {
	id: string;
	name?: string;
	capability?: string;
	h3Mode?: "image" | "reference" | "digital_human";
	h3InputMode?: H3InputMode;
	taskKind: "text_to_image" | "image_edit" | "text_to_video" | "image_to_video" | "text_to_audio";
	referenceImageCount: number;
	workflow: ComfyWorkflow;
	promptNodeIds?: string[];
	imageNodeIds?: string[];
	mediaLoaderNodeIds?: string[];
	outputNodeIds?: string[];
	outputMediaType?: "image" | "video" | "audio";
	audioLoaderNodeIds?: string[];
	emotionControlNodeIds?: string[];
	audioEmotionMode?: "basic" | "vector" | "text";
};

type ComfyConfig = {
	workflowVariants: WorkflowVariant[];
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function readEnv(c: AppContext, key: string): string {
	const value = c.env[key as keyof typeof c.env];
	if (typeof value === "string" && value.trim()) return value.trim();
	const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	return readString(processEnv?.[key]);
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function comfyUrl(baseUrl: string, path: string): string {
	return new URL(path.replace(/^\/+/, ""), `${baseUrl}/`).toString();
}

function parseWorkflow(value: unknown, field: string): ComfyWorkflow {
	if (!isRecord(value)) throw new AppError(`${field} 必须是 ComfyUI API 工作流对象`, { status: 500, code: "comfyui_workflow_invalid" });
	const entries = Object.entries(value);
	if (!entries.length || entries.some(([, node]) => !isRecord(node))) {
		throw new AppError(`${field} 不包含有效的节点图`, { status: 500, code: "comfyui_workflow_invalid" });
	}
	return value as ComfyWorkflow;
}

export function parseComfyUiWorkflowConfig(meta: unknown, modelKey: string): ComfyConfig {
	if (!isRecord(meta) || !isRecord(meta.comfyui) || !Array.isArray(meta.comfyui.workflowVariants)) {
		throw new AppError(`ComfyUI 模型 ${modelKey} 未配置 workflowVariants`, { status: 500, code: "comfyui_workflow_config_missing" });
	}
	const variants: WorkflowVariant[] = [];
	for (const [index, raw] of meta.comfyui.workflowVariants.entries()) {
		if (!isRecord(raw)) throw new AppError(`ComfyUI 工作流变体 ${index + 1} 配置无效`, { status: 500, code: "comfyui_workflow_config_invalid" });
		const id = readString(raw.id);
		const taskKind = raw.taskKind === "text_to_image" || raw.taskKind === "image_edit" || raw.taskKind === "text_to_video" || raw.taskKind === "image_to_video" || raw.taskKind === "text_to_audio" ? raw.taskKind : null;
		const count = typeof raw.referenceImageCount === "number" && Number.isInteger(raw.referenceImageCount) && raw.referenceImageCount >= 0 ? raw.referenceImageCount : null;
		if (!id || !taskKind || count === null) throw new AppError(`ComfyUI 工作流变体 ${index + 1} 缺少 id/taskKind/referenceImageCount`, { status: 500, code: "comfyui_workflow_config_invalid" });
		const promptNodeIds = Array.isArray(raw.promptNodeIds) ? raw.promptNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const imageNodeIds = Array.isArray(raw.imageNodeIds) ? raw.imageNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const mediaLoaderNodeIds = Array.isArray(raw.mediaLoaderNodeIds) ? raw.mediaLoaderNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const outputNodeIds = Array.isArray(raw.outputNodeIds) ? raw.outputNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const capability = readString(raw.capability);
		const h3Mode = raw.h3Mode === "image" || raw.h3Mode === "reference" || raw.h3Mode === "digital_human" ? raw.h3Mode : undefined;
		const h3InputMode = raw.h3InputMode === "text" || raw.h3InputMode === "first_frame" || raw.h3InputMode === "last_frame" || raw.h3InputMode === "first_last_frame" || raw.h3InputMode === "reference" || raw.h3InputMode === "digital_human" ? raw.h3InputMode : undefined;
		if (h3Mode && !h3InputMode) throw new AppError(`ComfyUI 工作流变体 ${id} 缺少 h3InputMode`, { status: 500, code: "comfyui_h3_input_mode_missing" });
		if (h3Mode === "image" && h3InputMode === "reference") throw new AppError(`ComfyUI 工作流变体 ${id} 的 h3Mode 与 h3InputMode 不一致`, { status: 500, code: "comfyui_h3_input_mode_invalid" });
		if (h3Mode === "reference" && h3InputMode !== "reference") throw new AppError(`ComfyUI 工作流变体 ${id} 的 h3Mode 与 h3InputMode 不一致`, { status: 500, code: "comfyui_h3_input_mode_invalid" });
		if (h3Mode === "digital_human" && h3InputMode !== "digital_human") throw new AppError(`ComfyUI 工作流变体 ${id} 的 h3Mode 与 h3InputMode 不一致`, { status: 500, code: "comfyui_h3_input_mode_invalid" });
		const outputMediaType = raw.outputMediaType === "image" || raw.outputMediaType === "video" || raw.outputMediaType === "audio" ? raw.outputMediaType : undefined;
		const audioLoaderNodeIds = Array.isArray(raw.audioLoaderNodeIds) ? raw.audioLoaderNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const emotionControlNodeIds = Array.isArray(raw.emotionControlNodeIds) ? raw.emotionControlNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const audioEmotionMode = raw.audioEmotionMode === "basic" || raw.audioEmotionMode === "vector" || raw.audioEmotionMode === "text" ? raw.audioEmotionMode : undefined;
		variants.push({ id, name: readString(raw.name) || undefined, ...(capability ? { capability } : {}), ...(h3Mode ? { h3Mode } : {}), ...(h3InputMode ? { h3InputMode } : {}), taskKind, referenceImageCount: count, workflow: parseWorkflow(raw.workflow, `ComfyUI 工作流变体 ${id}`), ...(promptNodeIds?.length ? { promptNodeIds } : {}), ...(imageNodeIds?.length ? { imageNodeIds } : {}), ...(mediaLoaderNodeIds?.length ? { mediaLoaderNodeIds } : {}), ...(outputNodeIds?.length ? { outputNodeIds } : {}), ...(outputMediaType ? { outputMediaType } : {}), ...(audioLoaderNodeIds?.length ? { audioLoaderNodeIds } : {}), ...(emotionControlNodeIds?.length ? { emotionControlNodeIds } : {}), ...(audioEmotionMode ? { audioEmotionMode } : {}) });
	}
	return { workflowVariants: variants };
}

function resolveH3InputMode(
	mediaInputs: readonly ComfyMediaInput[],
	requestedMode?: H3InputMode,
): H3InputMode {
	if (requestedMode === "digital_human") {
		const hasPortrait = mediaInputs.some((item) => item.type === "image");
		const hasAudio = mediaInputs.some((item) => item.type === "audio");
		if (!hasPortrait || !hasAudio) throw new AppError("MiniMax H3 数字人模式需要至少一张人物图片和一段驱动音频", { status: 400, code: "comfyui_h3_digital_human_input_missing" });
		if (mediaInputs.some((item) => item.role === "first_frame" || item.role === "last_frame")) throw new AppError("MiniMax H3 数字人模式不能携带首帧或尾帧角色", { status: 400, code: "comfyui_h3_digital_human_keyframe_conflict" });
		return requestedMode;
	}
	if (requestedMode) {
		if (requestedMode !== "reference") throw new AppError(`MiniMax H3 输入模式 ${requestedMode} 与实际媒体输入不一致`, { status: 400, code: "comfyui_h3_input_mode_conflict" });
		if (mediaInputs.length === 0) throw new AppError("MiniMax H3 全参考模式至少需要一项媒体", { status: 400, code: "comfyui_h3_reference_input_missing" });
		if (mediaInputs.some((item) => item.role === "first_frame" || item.role === "last_frame")) throw new AppError("MiniMax H3 全参考模式不能携带首帧或尾帧角色", { status: 400, code: "comfyui_h3_reference_keyframe_conflict" });
		return requestedMode;
	}
	if (mediaInputs.length === 0) return "text";
	const firstFrames = mediaInputs.filter((item) => item.role === "first_frame");
	const lastFrames = mediaInputs.filter((item) => item.role === "last_frame");
	const keyframeCount = firstFrames.length + lastFrames.length;
	if (keyframeCount > 0 && keyframeCount !== mediaInputs.length) throw new AppError("MiniMax H3 不能同时提交首帧/尾帧和普通参考素材；请二选一：移除首尾帧进入全参考模式，或移除普通参考素材仅使用首帧/尾帧模式", { status: 400, code: "comfyui_h3_mixed_input_unsupported", details: { keyframeCount, mediaInputCount: mediaInputs.length } });
	if (keyframeCount === 0) return "reference";
	if (mediaInputs.some((item) => item.type !== "image") || firstFrames.length > 1 || lastFrames.length > 1) throw new AppError("MiniMax H3 的首帧和尾帧各只能提供一张图片", { status: 400, code: "comfyui_h3_keyframe_count_invalid" });
	if (firstFrames.length === 1 && lastFrames.length === 1) return "first_last_frame";
	if (firstFrames.length === 1) return "first_frame";
	return "last_frame";
}

function normalizeH3Resolution(value: string): string {
	const trimmed = value.trim();
	return trimmed.toLowerCase() === "custom" ? "custom" : trimmed.toUpperCase();
}

export function selectComfyUiWorkflowVariant(
	config: ComfyConfig,
	input: { modelKey: string; taskKind: WorkflowVariant["taskKind"]; referenceImageCount?: number; mediaInputCount?: number; mediaInputs?: readonly ComfyMediaInput[]; capability?: string; h3InputMode?: H3InputMode },
): WorkflowVariant {
	const mediaInputs = input.mediaInputs ?? [];
	const requestedH3InputMode = input.h3InputMode;
	const resolvedH3InputMode = config.workflowVariants.some((variant) => Boolean(variant.h3InputMode))
		? resolveH3InputMode(mediaInputs, requestedH3InputMode)
		: undefined;
	const matches = config.workflowVariants.filter((variant) => {
		const isH3VideoVariant = Boolean(variant.h3InputMode) && (variant.taskKind === "text_to_video" || variant.taskKind === "image_to_video");
		const isH3VideoRequest = input.taskKind === "text_to_video" || input.taskKind === "image_to_video";
		const taskMatches = variant.taskKind === input.taskKind || (isH3VideoVariant && isH3VideoRequest && mediaInputs.length > 0);
		if (!taskMatches) return false;
		if (input.taskKind !== "text_to_video" && input.taskKind !== "image_to_video" && input.taskKind !== "text_to_audio" && variant.referenceImageCount !== input.referenceImageCount) return false;
		if (variant.h3InputMode && variant.h3InputMode !== resolvedH3InputMode) return false;
		return true;
	}).filter((variant) => !input.capability || variant.capability === input.capability || variant.id === input.capability);
	if (matches.length !== 1) throw new AppError(`ComfyUI 工作流无法唯一匹配：${input.modelKey}/${input.taskKind}${typeof input.referenceImageCount === "number" ? `/参考图${input.referenceImageCount}张` : typeof input.mediaInputCount === "number" ? `/媒体${input.mediaInputCount}项` : ""}`, { status: 400, code: "comfyui_workflow_route_not_unique", details: { modelKey: input.modelKey, taskKind: input.taskKind, referenceImageCount: input.referenceImageCount ?? null, mediaInputCount: input.mediaInputCount ?? mediaInputs.length, mediaInputRoles: mediaInputs.map((item) => item.role ?? null), matches: matches.map((variant) => variant.id) } });
	return matches[0]!;
}

async function resolveVariant(c: AppContext, modelKey: string, taskKind: WorkflowVariant["taskKind"], referenceImageCount: number, mediaInputs: readonly ComfyMediaInput[], capability?: string, h3InputMode?: H3InputMode): Promise<WorkflowVariant> {
	await ensureModelCatalogSchema(c.env.DB);
	const rows = await getPrismaClient().model_catalog_models.findMany({ where: { vendor_key: "comfyui", enabled: 1, OR: [{ model_key: modelKey }, { model_alias: modelKey }] }, select: { model_key: true, meta: true } });
	if (rows.length !== 1) throw new AppError(`ComfyUI 模型 ${modelKey} 不存在或匹配不唯一`, { status: 400, code: "comfyui_model_not_unique", details: { modelKey, matches: rows.map((row) => row.model_key) } });
	let meta: unknown = null;
	try { meta = rows[0]?.meta ? JSON.parse(rows[0].meta) as unknown : null; } catch { throw new AppError(`ComfyUI 模型 ${modelKey} 的 meta 不是合法 JSON`, { status: 500, code: "comfyui_model_meta_invalid" }); }
	return selectComfyUiWorkflowVariant(parseComfyUiWorkflowConfig(meta, modelKey), { modelKey, taskKind, referenceImageCount, mediaInputCount: mediaInputs.length, mediaInputs, ...(capability ? { capability } : {}), ...(h3InputMode ? { h3InputMode } : {}) });
}

function cloneWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
	return JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
}

export function resolveComfyUiSeed(
	request: TaskRequestDto,
	randomUuid: () => string = () => crypto.randomUUID(),
): number {
	if (typeof request.seed === "number" && Number.isFinite(request.seed)) {
		return Math.trunc(request.seed);
	}
	const uuidHex = randomUuid().split("-").join("").slice(0, 12);
	const seed = Number.parseInt(uuidHex, 16);
	if (!Number.isSafeInteger(seed)) {
		throw new AppError("ComfyUI 随机种子生成失败", { status: 500, code: "comfyui_seed_generation_failed" });
	}
	return seed;
}

function discoverNodeIds(workflow: ComfyWorkflow, kind: "prompt" | "image" | "output"): string[] {
	return Object.entries(workflow).filter(([, node]) => {
		const classType = readString(node.class_type).toLowerCase();
		if (kind === "prompt") return isRecord(node.inputs) && (Object.prototype.hasOwnProperty.call(node.inputs, "text") || (classType === "minimaxh3easy" && Object.prototype.hasOwnProperty.call(node.inputs, "prompt")));
		if (kind === "image") return classType === "loadimage";
		return classType === "saveimage" || classType === "saveimageadvanced" || classType === "previewimage";
	}).map(([id]) => id);
}

export function applyComfyUiWorkflowInputs(
	variant: WorkflowVariant,
	request: TaskRequestDto,
	uploadedNames: readonly string[],
	seed: number,
	mediaInputs: readonly UploadedComfyMedia[] = [],
): ComfyWorkflow {
	const workflow = cloneWorkflow(variant.workflow);
	for (const node of Object.values(workflow)) {
		if (!node.inputs) continue;
		for (const key of Object.keys(node.inputs)) {
			if (key === "seed" || key === "noise_seed") node.inputs[key] = seed;
		}
	}
	const promptIds = variant.promptNodeIds ?? discoverNodeIds(workflow, "prompt");
	if (promptIds.length === 0 && variant.taskKind !== "text_to_audio") throw new AppError(`ComfyUI 工作流 ${variant.id} 未找到提示词节点`, { status: 500, code: "comfyui_prompt_node_missing" });
	for (const id of promptIds) {
		const inputs = workflow[id]?.inputs;
		if (!inputs) throw new AppError(`ComfyUI 提示词节点 ${id} 不存在`, { status: 500, code: "comfyui_prompt_node_invalid" });
		if (Object.prototype.hasOwnProperty.call(inputs, "text")) inputs.text = request.prompt;
		if (Object.prototype.hasOwnProperty.call(inputs, "prompt")) inputs.prompt = request.prompt;
		const extras = isRecord(request.extras) ? request.extras : {};
		const h3Fields: Array<[string, string]> = [
			["resolution", "resolution"], ["aspectRatio", "aspect_ratio"], ["width", "width"], ["height", "height"],
			["durationSeconds", "seconds"], ["fps", "fps"], ["keyframeRole", "keyframe_role"],
		];
		for (const [extraKey, inputKey] of h3Fields) {
			if (typeof extras[extraKey] === "string" || typeof extras[extraKey] === "number") {
				inputs[inputKey] = inputKey === "resolution" && typeof extras[extraKey] === "string"
					? normalizeH3Resolution(extras[extraKey])
					: extras[extraKey];
			}
		}
	}
	if (variant.h3Mode) {
		const h3NodeIds = Object.entries(workflow)
			.filter(([, node]) => readString(node.class_type) === "MiniMaxH3Easy")
			.map(([id]) => id);
		if (h3NodeIds.length !== 1) throw new AppError(`ComfyUI 工作流 ${variant.id} 的 MiniMax H3 主节点必须唯一`, { status: 500, code: "comfyui_h3_node_not_unique" });
		const h3Inputs = workflow[h3NodeIds[0]!]!.inputs;
		if (!h3Inputs || !Object.prototype.hasOwnProperty.call(h3Inputs, "mode")) throw new AppError(`ComfyUI 工作流 ${variant.id} 的 MiniMax H3 主节点缺少 mode`, { status: 500, code: "comfyui_h3_mode_input_missing" });
		h3Inputs.mode = variant.h3Mode;
		const actualH3InputMode = resolveH3InputMode(mediaInputs, variant.h3InputMode === "digital_human" ? "digital_human" : undefined);
		if (variant.h3InputMode !== actualH3InputMode) throw new AppError(`MiniMax H3 工作流 ${variant.id} 的输入模式与媒体合同不一致`, { status: 400, code: "comfyui_h3_input_mode_conflict", details: { expected: variant.h3InputMode ?? null, actual: actualH3InputMode } });
		if (variant.h3Mode === "image" && Object.prototype.hasOwnProperty.call(h3Inputs, "keyframe_role")) {
			h3Inputs.keyframe_role = actualH3InputMode === "last_frame" ? "last" : "first";
		}
	}
	if (variant.taskKind === "text_to_audio") {
		const extras = isRecord(request.extras) ? request.extras : {};
		const audioLoaderIds = variant.audioLoaderNodeIds ?? Object.entries(workflow).filter(([, node]) => readString(node.class_type) === "XiaozhuguangAudioLoader").map(([id]) => id);
		if (audioLoaderIds.length !== 1) throw new AppError(`ComfyUI 工作流 ${variant.id} 的音频加载节点必须唯一`, { status: 500, code: "comfyui_audio_loader_not_unique" });
		const loaderInputs = workflow[audioLoaderIds[0]!]!.inputs;
		if (!loaderInputs) throw new AppError(`ComfyUI 音频节点 ${audioLoaderIds[0]} 无 inputs`, { status: 500, code: "comfyui_audio_loader_invalid" });
		const uploadedVoice = mediaInputs.find((item) => item.role === "reference" || item.role === "audio");
		if (!uploadedVoice) throw new AppError("IndexTTS 需要 voiceReferenceUrl 音色参考音频", { status: 400, code: "comfyui_voice_reference_missing" });
		if (Object.prototype.hasOwnProperty.call(loaderInputs, "音频")) loaderInputs["音频"] = uploadedVoice.filename;
		else if (Object.prototype.hasOwnProperty.call(loaderInputs, "audio")) loaderInputs.audio = uploadedVoice.filename;
		else throw new AppError(`ComfyUI 音频节点 ${audioLoaderIds[0]} 缺少音频输入字段`, { status: 500, code: "comfyui_audio_input_field_missing" });
		const mode = variant.audioEmotionMode;
		const controlIds = variant.emotionControlNodeIds ?? Object.entries(workflow).filter(([, node]) => readString(node.class_type) === "XZG_IndexTTS25_EmotionControl").map(([id]) => id);
		if (mode && controlIds.length !== 1) throw new AppError(`ComfyUI 工作流 ${variant.id} 的情绪控制节点必须唯一`, { status: 500, code: "comfyui_emotion_control_not_unique" });
		if (mode) {
			const controlInputs = workflow[controlIds[0]!]!.inputs;
			if (!controlInputs) throw new AppError(`ComfyUI 情绪控制节点 ${controlIds[0]} 无 inputs`, { status: 500, code: "comfyui_emotion_control_invalid" });
			if (mode === "vector") {
				const vector = extras.emotionVector;
				if (!Array.isArray(vector) || vector.length !== 8 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) throw new AppError("IndexTTS 情绪向量必须是 8 个 0 到 1 之间的数字", { status: 400, code: "comfyui_emotion_vector_invalid" });
				["happy", "angry", "sad", "afraid", "disgusted", "melancholic", "surprised", "calm"].forEach((name, index) => { const key = `mode.${name}`; if (Object.prototype.hasOwnProperty.call(controlInputs, key)) controlInputs[key] = vector[index]!; });
				if (Object.prototype.hasOwnProperty.call(controlInputs, "mode")) controlInputs.mode = "vector";
			} else if (mode === "text") {
				const emotionText = readString(extras.emotionText);
				if (!emotionText) throw new AppError("IndexTTS 文本情绪不能为空", { status: 400, code: "comfyui_emotion_text_missing" });
				if (Object.prototype.hasOwnProperty.call(controlInputs, "mode")) controlInputs.mode = "text";
				if (Object.prototype.hasOwnProperty.call(controlInputs, "mode.emotion_text")) controlInputs["mode.emotion_text"] = emotionText;
			} else if (Object.prototype.hasOwnProperty.call(controlInputs, "mode")) controlInputs.mode = "basic";
		}
	}
	// H3 的所有图片/视频/音频都通过 MiniMaxH3EasyMediaLoader 的 media_state
	// 传入，不使用传统 LoadImage 节点；因此不能再用参考图节点数量校验拦截 H3。
	if (!variant.h3InputMode) {
		const imageIds = variant.imageNodeIds ?? discoverNodeIds(workflow, "image");
		if (imageIds.length !== uploadedNames.length) throw new AppError(`ComfyUI 工作流 ${variant.id} 的参考图节点数与输入不一致`, { status: 400, code: "comfyui_reference_node_mismatch", details: { expected: imageIds.length, received: uploadedNames.length } });
		for (let index = 0; index < imageIds.length; index += 1) {
			const inputs = workflow[imageIds[index]!]!.inputs;
			if (!inputs) throw new AppError(`ComfyUI 图片节点 ${imageIds[index]} 无 inputs`, { status: 500, code: "comfyui_image_node_invalid" });
			inputs.image = uploadedNames[index]!;
		}
	}
	const mediaLoaderIds = variant.mediaLoaderNodeIds ?? Object.entries(workflow).filter(([, node]) => readString(node.class_type) === "MiniMaxH3EasyMediaLoader").map(([id]) => id);
	if (mediaLoaderIds.length > 0) {
		if (mediaInputs.length === 0 && variant.h3InputMode !== "text") throw new AppError(`ComfyUI 工作流 ${variant.id} 缺少媒体输入`, { status: 400, code: "comfyui_media_input_missing" });
		if (mediaLoaderIds.length !== 1) throw new AppError(`ComfyUI 工作流 ${variant.id} 的媒体加载节点必须唯一`, { status: 500, code: "comfyui_media_loader_not_unique" });
		const state = {
			images: mediaInputs.filter((item) => item.type === "image").map((item) => ({ filename: item.filename })),
			audios: mediaInputs.filter((item) => item.type === "audio").map((item) => ({ filename: item.filename })),
			videos: mediaInputs.filter((item) => item.type === "video").map((item) => ({ filename: item.filename })),
		};
		const loaderInputs = workflow[mediaLoaderIds[0]!]!.inputs;
		if (!loaderInputs) throw new AppError(`ComfyUI 媒体加载节点 ${mediaLoaderIds[0]} 无 inputs`, { status: 500, code: "comfyui_media_loader_invalid" });
		loaderInputs.media_state = JSON.stringify(state);
		for (const node of Object.values(workflow)) {
			if (!node.inputs) continue;
			if (Object.prototype.hasOwnProperty.call(node.inputs, "prompt_optimizer_resources")) {
				node.inputs.prompt_optimizer_resources = JSON.stringify(state.images.map((item, index) => ({ type: "image", tag: `<Picture ${index + 1}>`, name: item.filename, asset: { filename: item.filename, subfolder: "", storage: "input" } })));
			}
		}
	}
	return workflow;
}

async function uploadComfyMedia(baseUrl: string, token: string, media: ComfyMediaInput, index: number): Promise<UploadedComfyMedia> {
	const url = media.url.trim();
	let source: Response;
	try {
		source = await fetch(url);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AppError(`ComfyUI 媒体源拉取失败：${reason}`, { status: 502, code: "comfyui_media_fetch_failed", details: { type: media.type, sourceUrl: url, cause: reason } });
	}
	if (!source.ok) throw new AppError(`ComfyUI 媒体下载失败：${source.status}`, { status: 502, code: "comfyui_media_fetch_failed", details: { type: media.type, url } });
	const blob = await source.blob();
	const form = new FormData();
	const contentType = source.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || blob.type.toLowerCase();
	const ext = media.type === "image" ? (contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png") : media.type === "audio" ? (contentType.includes("wav") ? "wav" : contentType.includes("ogg") ? "ogg" : "mp3") : (contentType.includes("webm") ? "webm" : "mp4");
	const filename = `tapcanvas-${media.type}-${index + 1}.${ext}`;
	form.append("image", blob, filename);
	form.append("overwrite", "true");
	const uploadUrl = comfyUrl(baseUrl, "upload/image");
	let response: Response;
	try {
		response = await fetch(uploadUrl, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: form });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AppError(`ComfyUI 媒体上传连接失败：${reason}`, { status: 502, code: "comfyui_upload_failed", details: { type: media.type, endpoint: uploadUrl, cause: reason } });
	}
	if (!response.ok) throw new AppError(`ComfyUI 媒体上传失败：${response.status}`, { status: 502, code: "comfyui_upload_failed", details: { type: media.type, url } });
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !readString(payload.name)) throw new AppError("ComfyUI 上传响应缺少 name", { status: 502, code: "comfyui_upload_response_invalid" });
	return { ...media, filename: readString(payload.name) };
}

async function uploadReferenceImage(baseUrl: string, token: string, url: string, index: number): Promise<string> {
	return (await uploadComfyMedia(baseUrl, token, { type: "image", url, role: "reference" }, index)).filename;
}

async function runComfyRequest(baseUrl: string, token: string, workflow: ComfyWorkflow): Promise<{ promptId: string; response: unknown }> {
	const promptUrl = comfyUrl(baseUrl, "prompt");
	let response: Response;
	try {
		response = await fetch(promptUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ prompt: workflow, client_id: `tapcanvas-${crypto.randomUUID()}` }) });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AppError(`ComfyUI 提交连接失败：${reason}`, { status: 502, code: "comfyui_prompt_failed", details: { endpoint: promptUrl, cause: reason } });
	}
	const payload: unknown = await response.json();
	if (!response.ok) throw new AppError(`ComfyUI 提交失败：${response.status}`, { status: 502, code: "comfyui_prompt_failed", details: { response: payload } });
	if (!isRecord(payload) || !readString(payload.prompt_id)) throw new AppError("ComfyUI 提交响应缺少 prompt_id", { status: 502, code: "comfyui_prompt_response_invalid" });
	return { promptId: readString(payload.prompt_id), response: payload };
}

async function waitForComfyHistory(baseUrl: string, token: string, promptId: string, timeoutMs: number): Promise<JsonRecord> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const historyUrl = comfyUrl(baseUrl, `history/${encodeURIComponent(promptId)}`);
		let response: Response;
		try {
			response = await fetch(historyUrl, { headers: { Accept: "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new AppError(`ComfyUI 历史查询连接失败：${reason}`, { status: 502, code: "comfyui_history_failed", details: { endpoint: historyUrl, promptId, cause: reason } });
		}
		if (!response.ok) throw new AppError(`ComfyUI 历史查询失败：${response.status}`, { status: 502, code: "comfyui_history_failed" });
		const payload: unknown = await response.json();
		if (isRecord(payload) && isRecord(payload[promptId])) return payload[promptId] as JsonRecord;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new AppError(`ComfyUI 工作流超时：${promptId}`, { status: 504, code: "comfyui_timeout" });
}

function extractOutputFiles(history: JsonRecord, variant: WorkflowVariant, workflow: ComfyWorkflow): Array<{ filename: string; subfolder: string; type: string }> {
	const outputs = isRecord(history.outputs) ? history.outputs : {};
	const allowedIds = new Set(variant.outputNodeIds ?? discoverNodeIds(workflow, "output"));
	const files: Array<{ filename: string; subfolder: string; type: string }> = [];
	for (const [nodeId, raw] of Object.entries(outputs)) {
		if (allowedIds.size && !allowedIds.has(nodeId)) continue;
		if (!isRecord(raw)) continue;
		for (const key of ["images", "gifs", "videos", "audio", "audios"] as const) {
			const items = raw[key];
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				if (!isRecord(item)) continue;
				const filename = readString(item.filename);
				if (filename) files.push({ filename, subfolder: readString(item.subfolder), type: readString(item.type) || "output" });
			}
		}
	}
	return files;
}

export async function runComfyUiTask(c: AppContext, req: TaskRequestDto): Promise<TaskResultDto> {
	const baseUrl = normalizeBaseUrl(readEnv(c, "COMFYUI_BASE_URL"));
	if (!baseUrl) throw new AppError("COMFYUI_BASE_URL 未配置", { status: 500, code: "comfyui_not_configured" });
	const token = readEnv(c, "COMFYUI_API_TOKEN");
	const extras = isRecord(req.extras) ? req.extras : {};
	const modelKey = readString(extras.modelKey);
	if (!modelKey) throw new AppError("ComfyUI 任务缺少 extras.modelKey", { status: 400, code: "comfyui_model_missing" });
	const references = Array.isArray(extras.referenceImages) ? extras.referenceImages.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()) : [];
	const mediaInputs: ComfyMediaInput[] = [];
	if (typeof extras.mediaInputs !== "undefined") {
		if (!Array.isArray(extras.mediaInputs)) throw new AppError("ComfyUI extras.mediaInputs 必须是数组", { status: 400, code: "comfyui_media_input_invalid" });
		for (const [index, value] of extras.mediaInputs.entries()) {
			if (!isRecord(value) || (value.type !== "image" && value.type !== "audio" && value.type !== "video") || typeof value.url !== "string" || !value.url.trim()) {
				throw new AppError(`ComfyUI 媒体输入 ${index + 1} 无效`, { status: 400, code: "comfyui_media_input_invalid", details: { index } });
			}
			const role = value.role === "reference" || value.role === "first_frame" || value.role === "last_frame" || value.role === "audio" || value.role === "video" ? value.role : undefined;
			mediaInputs.push({ type: value.type, url: value.url.trim(), ...(role ? { role } : {}) });
		}
	}
	const audioReferenceUrl = readString(extras.voiceReferenceUrl);
	if (req.kind === "text_to_audio" && audioReferenceUrl) mediaInputs.push({ type: "audio", url: audioReferenceUrl, role: "reference" });
	const taskKind: WorkflowVariant["taskKind"] = req.kind === "text_to_video" || req.kind === "image_to_video" || req.kind === "text_to_audio" ? req.kind : mediaInputs.length > 0 ? "text_to_video" : references.length ? "image_edit" : "text_to_image";
	const capability = readString(extras.workflowCapability) || readString(extras.libTvImagePresetKey) || undefined;
	const requestedH3InputMode = extras.h3InputMode === "reference" || extras.h3InputMode === "digital_human" ? extras.h3InputMode : undefined;
	if (typeof extras.h3InputMode !== "undefined" && !requestedH3InputMode) throw new AppError("ComfyUI extras.h3InputMode 仅支持 reference 或 digital_human", { status: 400, code: "comfyui_h3_input_mode_invalid" });
	const variant = await resolveVariant(c, modelKey, taskKind, references.length, mediaInputs, capability, requestedH3InputMode);
	const seed = resolveComfyUiSeed(req);
	const uploadedNames: string[] = [];
	for (let index = 0; index < references.length; index += 1) uploadedNames.push(await uploadReferenceImage(baseUrl, token, references[index]!, index));
	const uploadedMedia: UploadedComfyMedia[] = [];
	for (let index = 0; index < mediaInputs.length; index += 1) uploadedMedia.push(await uploadComfyMedia(baseUrl, token, mediaInputs[index]!, index));
	const workflow = applyComfyUiWorkflowInputs(variant, req, uploadedNames, seed, uploadedMedia);
	const submitted = await runComfyRequest(baseUrl, token, workflow);
	const history = await waitForComfyHistory(baseUrl, token, submitted.promptId, Number(readEnv(c, "COMFYUI_POLL_TIMEOUT_MS")) || 1_800_000);
	const files = extractOutputFiles(history, variant, workflow);
	if (!files.length) throw new AppError(`ComfyUI 工作流 ${variant.id} 未产出媒体`, { status: 502, code: "comfyui_output_missing", details: { promptId: submitted.promptId } });
	const assets = [];
	for (const file of files) {
		const url = comfyUrl(baseUrl, `view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder)}&type=${encodeURIComponent(file.type)}`);
		const type = variant.outputMediaType || (req.kind === "text_to_video" || req.kind === "image_to_video" ? "video" : req.kind === "text_to_audio" ? "audio" : "image");
		assets.push(TaskAssetSchema.parse({ type, url }));
	}
	return TaskResultSchema.parse({ id: submitted.promptId, kind: req.kind, status: "succeeded", assets, raw: { provider: "comfyui", modelKey, workflowVariant: variant.id, seed, promptId: submitted.promptId, mediaInputs: uploadedMedia.map(({ filename: _filename, ...media }) => media), response: submitted.response, history } });
}
