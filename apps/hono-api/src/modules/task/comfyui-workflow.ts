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
	mediaInputNodeBinding?: "legacy_loaders";
	promptInputBindings?: Array<{ nodeId: string; inputKey: string }>;
	/**
	 * 显式把请求的 aspectRatio 写入指定节点的输入。
	 * 请求值命中 valueMap 时写入映射后的控件枚举值；未配置 valueMap 时按原值写入。
	 * 请求未携带比例时沿用工作流自带默认值，但该默认值必须落在已声明支持的枚举内；
	 * 否则显式失败，禁止静默沿用一个界面上并未显示的其它比例。
	 */
	aspectRatioInputBindings?: Array<{ nodeId: string; inputKey: string; valueMap?: Record<string, string> }>;
	/**
	 * 参考图数量为动态区间时的声明，与 referenceImageCount 互斥。
	 * 定数变体用 referenceImageCount 精确匹配；动态变体用区间匹配，
	 * 由请求实际携带的参考图数量落在 [min, max] 内决定是否命中。
	 */
	referenceImageRange?: { min: number; max: number };
	/**
	 * 动态参考图槽位绑定：为每张请求携带的参考图运行时生成一个 LoadImage 节点，
	 * 再按模板把它的 IMAGE 输出连到指定节点的 autogrow 输入键
	 * （例如 TextEncodeQwenImage21 的 images.image_{index}、BatchImagesNode 的 images.image{index}）。
	 * autogrow 槽位是 IMAGE 类型，只能接节点输出，不能直接写文件名，因此必须动态建节点。
	 * 声明该字段的变体不得再声明 imageNodeIds；工作流必须在目录构建阶段剔除
	 * 编辑器遗留的 LoadImage 节点，否则运行时显式报错，不静默沿用未托管的文件名。
	 */
	referenceImageSlots?: Array<{
		nodeId: string;
		inputKeyTemplate: string;
		startIndex: number;
		maxSlots: number;
	}>;
	/**
	 * 动态参考图 LoadImage 节点 id 模板（必须包含 {index}）。
	 * 同一张参考图被多个槽位复用时只创建一个 LoadImage 节点，避免重复加载。
	 */
	referenceImageLoaderNodeIdTemplate?: string;
	/**
	 * 把画布输出尺寸换算成「参考图编码分辨率」写入指定 INT 输入。
	 *
	 * ComfyUI 的 TextEncodeQwenImage21.resolution 语义是「参考图缩放到约
	 * resolution × resolution 像素」（面积等效边长，节点内部按 32 对齐），
	 * 因此这里用画布输出尺寸的几何平均边长换算，而不是直接取宽或高——
	 * 直接取宽或高会让竖图与横图的参考图编码量相差数倍。
	 * 请求未携带可解析的画布尺寸时保留工作流默认值，但该默认值必须落在
	 * 声明范围内，否则显式失败，不静默沿用未声明的编码规模。
	 */
	imageResolutionInputBindings?: Array<{
		nodeId: string;
		inputKey: string;
		/** 对齐步长，必须与节点声明的 step 一致。 */
		alignTo: number;
		min: number;
		max: number;
		/**
		 * 请求未携带像素尺寸时的画布规模来源：工作流的 ResolutionSelector 节点 id。
		 *
		 * ResolutionSelector 的输出满足 width × height ≈ megapixels × 1024²，
		 * 因此面积等效边长 = 1024 × sqrt(megapixels)，与画幅比例无关，
		 * 不需要复制该节点的比例表，也不依赖比例枚举的具体文案。
		 */
		megapixelsFromNodeId?: string;
	}>;
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
		const referenceImageRange = (() => {
			if (!isRecord(raw.referenceImageRange)) return null;
			const min = typeof raw.referenceImageRange.min === "number" && Number.isInteger(raw.referenceImageRange.min) ? raw.referenceImageRange.min : null;
			const max = typeof raw.referenceImageRange.max === "number" && Number.isInteger(raw.referenceImageRange.max) ? raw.referenceImageRange.max : null;
			if (min === null || max === null) throw new AppError(`ComfyUI 工作流变体 ${index + 1} 的 referenceImageRange 必须是 { min, max } 整数区间`, { status: 500, code: "comfyui_workflow_config_invalid" });
			if (min < 1) throw new AppError(`ComfyUI 工作流变体 ${index + 1} 的 referenceImageRange.min 必须大于等于 1`, { status: 500, code: "comfyui_workflow_config_invalid" });
			if (max < min) throw new AppError(`ComfyUI 工作流变体 ${index + 1} 的 referenceImageRange.max 不能小于 min`, { status: 500, code: "comfyui_workflow_config_invalid" });
			return { min, max };
		})();
		if (!id || !taskKind) throw new AppError(`ComfyUI 工作流变体 ${index + 1} 缺少 id/taskKind`, { status: 500, code: "comfyui_workflow_config_invalid" });
		if ((count === null) === (referenceImageRange === null)) throw new AppError(`ComfyUI 工作流变体 ${index + 1} 必须且只能声明 referenceImageCount 或 referenceImageRange 之一`, { status: 500, code: "comfyui_workflow_config_invalid" });
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
		const mediaInputNodeBinding = raw.mediaInputNodeBinding === "legacy_loaders" ? "legacy_loaders" : undefined;
		const promptInputBindings = Array.isArray(raw.promptInputBindings)
			? raw.promptInputBindings.flatMap((value) => {
				if (!isRecord(value)) return [];
				const nodeId = readString(value.nodeId);
				const inputKey = readString(value.inputKey);
				return nodeId && inputKey ? [{ nodeId, inputKey }] : [];
			})
			: undefined;
		const aspectRatioInputBindings = Array.isArray(raw.aspectRatioInputBindings)
			? raw.aspectRatioInputBindings.flatMap((value) => {
				if (!isRecord(value)) return [];
				const nodeId = readString(value.nodeId);
				const inputKey = readString(value.inputKey);
				if (!nodeId || !inputKey) return [];
				const valueMap = isRecord(value.valueMap)
					? Object.fromEntries(Object.entries(value.valueMap).flatMap(([rawKey, rawValue]) => {
						const key = rawKey.trim();
						const mapped = readString(rawValue);
						return key && mapped ? [[key, mapped] as const] : [];
					}))
					: null;
				return [{
					nodeId,
					inputKey,
					...(valueMap && Object.keys(valueMap).length ? { valueMap } : {}),
				}];
			})
			: undefined;
		const imageSizeInputBindings = Array.isArray(raw.imageSizeInputBindings)
			? raw.imageSizeInputBindings.flatMap((value) => {
				if (!isRecord(value)) return [];
				const nodeId = readString(value.nodeId);
				const inputKey = readString(value.inputKey);
				if (!nodeId || !inputKey) return [];
				const valueMap = isRecord(value.valueMap)
					? Object.fromEntries(Object.entries(value.valueMap).flatMap(([rawKey, rawValue]) => {
						const key = rawKey.trim();
						const mapped = typeof rawValue === "number" || typeof rawValue === "string" ? rawValue : null;
						return key && mapped !== null ? [[key, mapped] as const] : [];
					}))
					: null;
				return [{
					nodeId,
					inputKey,
					...(valueMap && Object.keys(valueMap).length ? { valueMap } : {}),
				}];
			})
			: undefined;
		const referenceImageSlots = Array.isArray(raw.referenceImageSlots)
			? raw.referenceImageSlots.flatMap((value) => {
				if (!isRecord(value)) return [];
				const nodeId = readString(value.nodeId);
				const inputKeyTemplate = readString(value.inputKeyTemplate);
				const startIndex = typeof value.startIndex === "number" && Number.isInteger(value.startIndex) ? value.startIndex : null;
				const maxSlots = typeof value.maxSlots === "number" && Number.isInteger(value.maxSlots) ? value.maxSlots : null;
				if (!nodeId || !inputKeyTemplate || startIndex === null || maxSlots === null) return [];
				if (maxSlots < 1) throw new AppError(`ComfyUI 工作流变体 ${id} 的参考图槽位 maxSlots 必须大于等于 1`, { status: 500, code: "comfyui_workflow_config_invalid" });
				if (startIndex < 0) throw new AppError(`ComfyUI 工作流变体 ${id} 的参考图槽位 startIndex 不能为负数`, { status: 500, code: "comfyui_workflow_config_invalid" });
				if (!inputKeyTemplate.includes("{index}")) throw new AppError(`ComfyUI 工作流变体 ${id} 的参考图槽位 inputKeyTemplate 必须包含 {index}`, { status: 500, code: "comfyui_workflow_config_invalid" });
				return [{ nodeId, inputKeyTemplate, startIndex, maxSlots }];
			})
			: undefined;
		const referenceImageLoaderNodeIdTemplate = readString(raw.referenceImageLoaderNodeIdTemplate) || undefined;
		const imageResolutionInputBindings = Array.isArray(raw.imageResolutionInputBindings)
			? raw.imageResolutionInputBindings.flatMap((value) => {
				if (!isRecord(value)) return [];
				const nodeId = readString(value.nodeId);
				const inputKey = readString(value.inputKey);
				const alignTo = typeof value.alignTo === "number" && Number.isInteger(value.alignTo) && value.alignTo > 0 ? value.alignTo : null;
				const min = typeof value.min === "number" && Number.isInteger(value.min) ? value.min : null;
				const max = typeof value.max === "number" && Number.isInteger(value.max) ? value.max : null;
				if (!nodeId || !inputKey || alignTo === null || min === null || max === null) return [];
				if (max < min) throw new AppError(`ComfyUI 工作流变体 ${id} 的参考图编码分辨率绑定 max 不能小于 min`, { status: 500, code: "comfyui_workflow_config_invalid" });
				const megapixelsFromNodeId = readString(value.megapixelsFromNodeId) || undefined;
				return [{ nodeId, inputKey, alignTo, min, max, ...(megapixelsFromNodeId ? { megapixelsFromNodeId } : {}) }];
			})
			: undefined;
		if (referenceImageSlots?.length) {
			if (!referenceImageLoaderNodeIdTemplate) throw new AppError(`ComfyUI 工作流变体 ${id} 声明 referenceImageSlots 时必须声明 referenceImageLoaderNodeIdTemplate`, { status: 500, code: "comfyui_reference_slot_binding_conflict" });
			if (!referenceImageLoaderNodeIdTemplate.includes("{index}")) throw new AppError(`ComfyUI 工作流变体 ${id} 的 referenceImageLoaderNodeIdTemplate 必须包含 {index}`, { status: 500, code: "comfyui_workflow_config_invalid" });
		} else if (referenceImageLoaderNodeIdTemplate) {
			throw new AppError(`ComfyUI 工作流变体 ${id} 声明了 referenceImageLoaderNodeIdTemplate 但缺少 referenceImageSlots`, { status: 500, code: "comfyui_reference_slot_binding_conflict" });
		}
		if (mediaInputNodeBinding && (!imageNodeIds?.length || !audioLoaderNodeIds?.length)) {
			throw new AppError(`ComfyUI 工作流变体 ${id} 的传统媒体绑定必须声明图片和音频加载节点`, { status: 500, code: "comfyui_legacy_media_binding_invalid" });
		}
		if (referenceImageSlots?.length) {
			if (imageNodeIds?.length) throw new AppError(`ComfyUI 工作流变体 ${id} 不能同时声明 referenceImageSlots 与 imageNodeIds`, { status: 500, code: "comfyui_reference_slot_binding_conflict" });
			if (!referenceImageRange) throw new AppError(`ComfyUI 工作流变体 ${id} 声明 referenceImageSlots 时必须同时声明 referenceImageRange`, { status: 500, code: "comfyui_reference_slot_binding_conflict" });
			const uncovered = referenceImageSlots.filter((slot) => slot.maxSlots < referenceImageRange.max);
			if (uncovered.length) throw new AppError(`ComfyUI 工作流变体 ${id} 的参考图槽位数量不足以覆盖 referenceImageRange.max=${referenceImageRange.max}`, { status: 500, code: "comfyui_reference_slot_capacity_invalid", details: { required: referenceImageRange.max, slots: referenceImageSlots.map((slot) => ({ nodeId: slot.nodeId, maxSlots: slot.maxSlots })) } });
		}
		const emotionControlNodeIds = Array.isArray(raw.emotionControlNodeIds) ? raw.emotionControlNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const audioEmotionMode = raw.audioEmotionMode === "basic" || raw.audioEmotionMode === "vector" || raw.audioEmotionMode === "text" ? raw.audioEmotionMode : undefined;
		variants.push({ id, name: readString(raw.name) || undefined, ...(capability ? { capability } : {}), ...(h3Mode ? { h3Mode } : {}), ...(h3InputMode ? { h3InputMode } : {}), taskKind, referenceImageCount: count ?? referenceImageRange!.min, ...(referenceImageRange ? { referenceImageRange } : {}), workflow: parseWorkflow(raw.workflow, `ComfyUI 工作流变体 ${id}`), ...(promptNodeIds?.length ? { promptNodeIds } : {}), ...(promptInputBindings?.length ? { promptInputBindings } : {}), ...(aspectRatioInputBindings?.length ? { aspectRatioInputBindings } : {}), ...(imageResolutionInputBindings?.length ? { imageResolutionInputBindings } : {}), ...(referenceImageSlots?.length ? { referenceImageSlots } : {}), ...(referenceImageLoaderNodeIdTemplate ? { referenceImageLoaderNodeIdTemplate } : {}), ...(imageNodeIds?.length ? { imageNodeIds } : {}), ...(mediaLoaderNodeIds?.length ? { mediaLoaderNodeIds } : {}), ...(outputNodeIds?.length ? { outputNodeIds } : {}), ...(outputMediaType ? { outputMediaType } : {}), ...(audioLoaderNodeIds?.length ? { audioLoaderNodeIds } : {}), ...(mediaInputNodeBinding ? { mediaInputNodeBinding } : {}), ...(emotionControlNodeIds?.length ? { emotionControlNodeIds } : {}), ...(audioEmotionMode ? { audioEmotionMode } : {}) });
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
		if (input.taskKind !== "text_to_video" && input.taskKind !== "image_to_video" && input.taskKind !== "text_to_audio") {
			// 动态区间变体按请求实际参考图数量落区间匹配；定数变体保持精确匹配。
			if (variant.referenceImageRange) {
				const requested = input.referenceImageCount;
				if (typeof requested !== "number" || requested < variant.referenceImageRange.min || requested > variant.referenceImageRange.max) return false;
			} else if (variant.referenceImageCount !== input.referenceImageCount) return false;
		}
		if (variant.h3InputMode && variant.h3InputMode !== resolvedH3InputMode) return false;
		return true;
	}).filter((variant) => input.capability
		? variant.capability === input.capability || variant.id === input.capability
		: !variant.capability);
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

/**
 * 解析画布输出的面积等效边长（像素），用于把「参考图编码分辨率」对齐到画布设置。
 *
 * 取值优先级（确定性，不做猜测）：
 * 1. 请求携带的像素尺寸 width/height → 几何平均边长。这是画布上最具体的尺寸设置
 *    （imageEdit 节点会带上它），优先采用。
 * 2. 工作流 ResolutionSelector 的 megapixels → 1024 × sqrt(megapixels)。
 *    普通图片节点只携带画幅比例，此时用工作流自身的输出规模推导，
 *    保证参考图编码与真实输出对齐，避免欠采样。
 *
 * 三者都无法确定时返回 null，由调用方决定是保留工作流默认值还是显式失败。
 */
function resolveCanvasOutputEdge(
	request: TaskRequestDto,
	workflow: ComfyWorkflow,
	binding: { megapixelsFromNodeId?: string },
): number | null {
	const width = typeof request.width === "number" && Number.isFinite(request.width) && request.width > 0 ? request.width : null;
	const height = typeof request.height === "number" && Number.isFinite(request.height) && request.height > 0 ? request.height : null;
	if (width !== null && height !== null) return Math.sqrt(width * height);

	const megapixelsNodeId = binding.megapixelsFromNodeId;
	if (megapixelsNodeId) {
		const megapixels = workflow[megapixelsNodeId]?.inputs?.megapixels;
		if (typeof megapixels === "number" && Number.isFinite(megapixels) && megapixels > 0) {
			return Math.sqrt(megapixels) * 1024;
		}
	}
	return null;
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
	const promptBindings = variant.promptInputBindings ?? [];
	if (promptIds.length === 0 && promptBindings.length === 0 && variant.taskKind !== "text_to_audio") throw new AppError(`ComfyUI 工作流 ${variant.id} 未找到提示词节点`, { status: 500, code: "comfyui_prompt_node_missing" });
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
	for (const binding of promptBindings) {
		const inputs = workflow[binding.nodeId]?.inputs;
		if (!inputs) throw new AppError(`ComfyUI 提示词绑定节点 ${binding.nodeId} 不存在`, { status: 500, code: "comfyui_prompt_binding_node_invalid" });
		if (!Object.prototype.hasOwnProperty.call(inputs, binding.inputKey)) {
			throw new AppError(`ComfyUI 提示词绑定节点 ${binding.nodeId} 缺少输入字段 ${binding.inputKey}`, { status: 500, code: "comfyui_prompt_binding_input_missing" });
		}
		inputs[binding.inputKey] = request.prompt;
	}
	// 画幅比例必须显式落到工作流的尺寸控件上：ComfyUI 会静默忽略未知输入字段，
	// 若只写入提示词节点，画布上的比例选择会看起来成功但实际不生效。
	for (const binding of variant.aspectRatioInputBindings ?? []) {
		const inputs = workflow[binding.nodeId]?.inputs;
		if (!inputs) throw new AppError(`ComfyUI 画幅绑定节点 ${binding.nodeId} 不存在`, { status: 500, code: "comfyui_aspect_binding_node_invalid" });
		if (!Object.prototype.hasOwnProperty.call(inputs, binding.inputKey)) {
			throw new AppError(`ComfyUI 画幅绑定节点 ${binding.nodeId} 缺少输入字段 ${binding.inputKey}`, { status: 500, code: "comfyui_aspect_binding_input_missing" });
		}
		const requestedAspect = readString(isRecord(request.extras) ? request.extras.aspectRatio : "");
		const supported = binding.valueMap
			? Object.keys(binding.valueMap)
			: null;
		if (!requestedAspect) {
			// 未携带比例时保留工作流自带默认值，但它必须仍是目录声明支持的一项。
			const existing = readString(inputs[binding.inputKey]);
			const allowedValues = binding.valueMap
				? Object.values(binding.valueMap)
				: null;
			if (allowedValues && !allowedValues.includes(existing)) {
				throw new AppError(`ComfyUI 工作流 ${variant.id} 未携带画幅比例，且工作流默认值 ${existing || "(空)"} 不在支持列表内`, { status: 400, code: "comfyui_aspect_ratio_missing", details: { model_workflow_default: existing, supported } });
			}
			continue;
		}
		const mapped = binding.valueMap ? binding.valueMap[requestedAspect] : requestedAspect;
		if (!mapped) {
			throw new AppError(`ComfyUI 工作流 ${variant.id} 不支持画幅比例 ${requestedAspect}`, { status: 400, code: "comfyui_aspect_ratio_not_supported", details: { requested: requestedAspect, supported } });
		}
		inputs[binding.inputKey] = mapped;
	}
	// 参考图编码分辨率跟随画布输出尺寸：ComfyUI 的 resolution 是「约 resolution²像素」的
	// 面积等效边长，因此用宽高的几何平均再对齐到节点声明的 step。这样横图与竖图在
	// 同一画布尺寸下得到一致的参考图编码量，也避免把画布宽度直接当作边长导致竖图过采样。
	for (const binding of variant.imageResolutionInputBindings ?? []) {
		const inputs = workflow[binding.nodeId]?.inputs;
		if (!inputs) throw new AppError(`ComfyUI 参考图编码分辨率节点 ${binding.nodeId} 不存在`, { status: 500, code: "comfyui_image_resolution_binding_node_invalid" });
		if (!Object.prototype.hasOwnProperty.call(inputs, binding.inputKey)) {
			throw new AppError(`ComfyUI 参考图编码分辨率节点 ${binding.nodeId} 缺少输入字段 ${binding.inputKey}`, { status: 500, code: "comfyui_image_resolution_binding_input_missing" });
		}
		const geometricMean = resolveCanvasOutputEdge(request, workflow, binding);
		if (geometricMean === null) {
			// 画布尺寸与工作流规模都无法确定时保留工作流默认值，但它必须仍在声明范围内，
			// 否则说明界面上无法表达该编码规模，显式失败而不是静默沿用。
			const existing = typeof inputs[binding.inputKey] === "number" ? inputs[binding.inputKey] as number : null;
			if (existing === null || existing < binding.min || existing > binding.max) {
				throw new AppError(`ComfyUI 工作流 ${variant.id} 无法确定画布输出尺寸，且工作流默认参考图编码分辨率 ${existing ?? "(空)"} 不在声明范围 ${binding.min}-${binding.max} 内`, { status: 400, code: "comfyui_image_resolution_missing", details: { model_workflow_default: existing, min: binding.min, max: binding.max } });
			}
			continue;
		}
		const aligned = Math.round(geometricMean / binding.alignTo) * binding.alignTo;
		const clamped = Math.min(binding.max, Math.max(binding.min, aligned));
		inputs[binding.inputKey] = clamped;
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
	if (variant.mediaInputNodeBinding === "legacy_loaders") {
		if (uploadedNames.length > 0) {
			throw new AppError(`ComfyUI 工作流 ${variant.id} 的传统媒体绑定只接受 extras.mediaInputs`, { status: 400, code: "comfyui_legacy_media_source_invalid" });
		}
		const imageMedia = mediaInputs.filter((item) => item.type === "image");
		const audioMedia = mediaInputs.filter((item) => item.type === "audio");
		const unsupportedMedia = mediaInputs.filter((item) => item.type === "video");
		const imageIds = variant.imageNodeIds!;
		const audioIds = variant.audioLoaderNodeIds!;
		if (unsupportedMedia.length > 0) {
			throw new AppError(`ComfyUI 工作流 ${variant.id} 不支持视频媒体输入`, { status: 400, code: "comfyui_legacy_media_type_unsupported", details: { unsupportedTypes: unsupportedMedia.map((item) => item.type) } });
		}
		if (imageMedia.length !== imageIds.length) {
			throw new AppError(`ComfyUI 工作流 ${variant.id} 的图片加载节点数与输入不一致`, { status: 400, code: "comfyui_legacy_image_node_mismatch", details: { expected: imageIds.length, received: imageMedia.length } });
		}
		if (audioMedia.length !== audioIds.length) {
			throw new AppError(`ComfyUI 工作流 ${variant.id} 的音频加载节点数与输入不一致`, { status: 400, code: "comfyui_legacy_audio_node_mismatch", details: { expected: audioIds.length, received: audioMedia.length } });
		}
		for (let index = 0; index < imageIds.length; index += 1) {
			const nodeId = imageIds[index]!;
			const inputs = workflow[nodeId]?.inputs;
			if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, "image")) {
				throw new AppError(`ComfyUI 图片节点 ${nodeId} 缺少 image 输入字段`, { status: 500, code: "comfyui_legacy_image_input_missing" });
			}
			inputs.image = imageMedia[index]!.filename;
		}
		for (let index = 0; index < audioIds.length; index += 1) {
			const nodeId = audioIds[index]!;
			const inputs = workflow[nodeId]?.inputs;
			if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, "audio")) {
				throw new AppError(`ComfyUI 音频节点 ${nodeId} 缺少 audio 输入字段`, { status: 500, code: "comfyui_legacy_audio_input_missing" });
			}
			inputs.audio = audioMedia[index]!.filename;
		}
	// H3 Easy 的所有图片/视频/音频都通过 MiniMaxH3EasyMediaLoader 的 media_state
	// 传入，不使用传统 LoadImage 节点；因此不能再用参考图节点数量校验拦截 H3。
	} else if (variant.referenceImageSlots?.length) {
		// 动态参考图槽位：请求带几张图就写几个 autogrow 槽，未使用的槽位保持缺省，
		// 由 ComfyUI 的 min=0 契约接受。工作流里若仍残留编辑器遗留的 LoadImage 节点，
		// 说明目录构建阶段没有做硬切换，这里显式失败而不是静默沿用未托管的文件名。
		const leftoverLoaders = discoverNodeIds(workflow, "image");
		if (leftoverLoaders.length) {
			throw new AppError(`ComfyUI 工作流 ${variant.id} 声明了动态参考图槽位，但工作流仍残留 ${leftoverLoaders.length} 个 LoadImage 节点`, { status: 500, code: "comfyui_reference_slot_loader_conflict", details: { loaders: leftoverLoaders } });
		}
		const range = variant.referenceImageRange!;
		if (uploadedNames.length < range.min || uploadedNames.length > range.max) {
			throw new AppError(`ComfyUI 工作流 ${variant.id} 的参考图数量 ${uploadedNames.length} 不在支持区间 ${range.min}-${range.max} 内`, { status: 400, code: "comfyui_reference_count_out_of_range", details: { received: uploadedNames.length, min: range.min, max: range.max } });
		}
		for (const slot of variant.referenceImageSlots) {
			const inputs = workflow[slot.nodeId]?.inputs;
			if (!inputs) throw new AppError(`ComfyUI 参考图槽位节点 ${slot.nodeId} 不存在`, { status: 500, code: "comfyui_reference_slot_node_invalid" });
			for (let index = 0; index < uploadedNames.length; index += 1) {
				const slotIndex = slot.startIndex + index;
				if (index >= slot.maxSlots) throw new AppError(`ComfyUI 参考图槽位节点 ${slot.nodeId} 容量不足：最多 ${slot.maxSlots} 张`, { status: 500, code: "comfyui_reference_slot_capacity_invalid", details: { nodeId: slot.nodeId, received: uploadedNames.length, maxSlots: slot.maxSlots } });
				const inputKey = slot.inputKeyTemplate.replace("{index}", String(slotIndex));
				// autogrow 槽位是 IMAGE 类型，只能接节点输出；这里为每张参考图生成一个
				// LoadImage 节点，再以 [节点 id, 输出槽位 0] 连线。同一张参考图被多个槽位
				// 复用时只建一个节点；id 与工作流既有节点冲突时显式失败，避免静默覆盖。
				const loaderNodeId = variant.referenceImageLoaderNodeIdTemplate!.replace("{index}", String(index));
				if (!workflow[loaderNodeId]) {
					if (Object.prototype.hasOwnProperty.call(variant.workflow, loaderNodeId)) {
						throw new AppError(`ComfyUI 参考图 LoadImage id ${loaderNodeId} 与工作流既有节点冲突`, { status: 500, code: "comfyui_reference_slot_loader_id_conflict", details: { nodeId: slot.nodeId, loaderNodeId } });
					}
					workflow[loaderNodeId] = { class_type: "LoadImage", inputs: { image: uploadedNames[index]! } };
				}
				inputs[inputKey] = [loaderNodeId, 0];
			}
		}
	} else if (!variant.h3InputMode) {
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

function extractComfyHistoryStatus(history: JsonRecord): "running" | "succeeded" | "failed" {
	const status = isRecord(history.status) ? history.status : null;
	const statusString = readString(status?.status_str).toLowerCase();
	if (statusString === "error" || statusString === "failed") return "failed";
	if (status?.completed === true || statusString === "success") return "succeeded";
	return "running";
}

function extractComfyHistoryFiles(history: JsonRecord): Array<{ filename: string; subfolder: string; type: string }> {
	const outputs = isRecord(history.outputs) ? history.outputs : {};
	const files: Array<{ filename: string; subfolder: string; type: string }> = [];
	for (const raw of Object.values(outputs)) {
		if (!isRecord(raw)) continue;
		for (const key of ["images", "gifs", "videos", "video", "audio", "audios"] as const) {
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

/**
 * 查询一次本地 ComfyUI 任务，不在请求线程内等待生成完成。
 * 这是 H3 提交即返回后的统一收口入口，由任务轮询/reconcile 调用。
 */
export async function fetchComfyUiTaskResult(
	c: AppContext,
	input: { taskId: string; taskKind: TaskRequestDto["kind"]; timeoutMs?: number },
): Promise<TaskResultDto> {
	const baseUrl = normalizeBaseUrl(readEnv(c, "COMFYUI_BASE_URL"));
	if (!baseUrl) throw new AppError("COMFYUI_BASE_URL 未配置", { status: 500, code: "comfyui_not_configured" });
	const promptId = input.taskId.trim();
	if (!promptId) throw new AppError("ComfyUI 任务缺少 prompt_id", { status: 400, code: "comfyui_prompt_id_missing" });
	const historyUrl = comfyUrl(baseUrl, `history/${encodeURIComponent(promptId)}`);
	let response: Response;
	try {
		response = await fetch(historyUrl, { headers: { Accept: "application/json", ...(readEnv(c, "COMFYUI_API_TOKEN") ? { Authorization: `Bearer ${readEnv(c, "COMFYUI_API_TOKEN")}` } : {}) }, signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AppError(`ComfyUI 历史查询连接失败：${reason}`, { status: 502, code: "comfyui_history_failed", details: { endpoint: historyUrl, promptId, cause: reason } });
	}
	if (!response.ok) throw new AppError(`ComfyUI 历史查询失败：${response.status}`, { status: 502, code: "comfyui_history_failed", details: { endpoint: historyUrl, promptId } });
	const payload: unknown = await response.json();
	const history = isRecord(payload) && isRecord(payload[promptId]) ? payload[promptId] as JsonRecord : null;
	if (!history) return TaskResultSchema.parse({ id: promptId, kind: input.taskKind, status: "running", assets: [], raw: { provider: "comfyui", promptId } });
	const status = extractComfyHistoryStatus(history);
	if (status !== "succeeded") return TaskResultSchema.parse({ id: promptId, kind: input.taskKind, status, assets: [], raw: { provider: "comfyui", promptId, history } });
	const assets = extractComfyHistoryFiles(history).map((file) => TaskAssetSchema.parse({ type: input.taskKind === "text_to_audio" ? "audio" : input.taskKind === "text_to_image" || input.taskKind === "image_edit" ? "image" : "video", url: comfyUrl(baseUrl, `view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder)}&type=${encodeURIComponent(file.type)}`) }));
	if (!assets.length) return TaskResultSchema.parse({ id: promptId, kind: input.taskKind, status: "failed", assets: [], raw: { provider: "comfyui", promptId, error: "ComfyUI 工作流已完成但未产出媒体", history } });
	return TaskResultSchema.parse({ id: promptId, kind: input.taskKind, status: "succeeded", assets, raw: { provider: "comfyui", promptId, history } });
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
	if (req.kind === "text_to_video" || req.kind === "image_to_video") {
		return TaskResultSchema.parse({ id: submitted.promptId, kind: req.kind, status: "running", assets: [], raw: { provider: "comfyui", modelKey, workflowVariant: variant.id, seed, promptId: submitted.promptId, mediaInputs: uploadedMedia.map(({ filename: _filename, ...media }) => media), response: submitted.response } });
	}
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
