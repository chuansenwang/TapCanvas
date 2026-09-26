import type {
	PublicChatEnabledModelCatalogSummary,
} from "../model-catalog/model-catalog.public-chat-summary";
import { stableContentHash } from "./video-orchestrator.authoring.repo";

export type AgentImageExecutionCatalog = {
	kind: "image";
	fetchedAt: string;
	revision: string;
	selectionContract: string;
	models: Array<{
		modelKey: string;
		label: string;
		pricingCost: number | null;
		imageOptions: PublicChatEnabledModelCatalogSummary["imageModels"][number]["imageOptions"];
	}>;
};

export function buildAgentImageExecutionCatalog(
	summary: PublicChatEnabledModelCatalogSummary,
	fetchedAt: string,
): AgentImageExecutionCatalog {
	const models = summary.imageModels.map((model) => ({
		modelKey: model.modelKey,
		label: model.labelZh,
		pricingCost: model.pricingCost,
		imageOptions: model.imageOptions,
	}));
	return {
		kind: "image",
		fetchedAt,
		revision: stableContentHash(models),
		selectionContract:
			"Set node.data.imageModel to one exact modelKey from this list. When the selected model declares imageOptions, set node.data.aspect and node.data.imageSize to exact supported values. Never invent, translate, shorten, substitute, or silently default a model identity or media specification.",
		models,
	};
}

export type AgentVideoExecutionCatalog = {
	kind: "video";
	fetchedAt: string;
	revision: string;
	selectionContract: string;
	models: Array<{
		modelKey: string;
		modelAlias: string | null;
		vendorKey: string;
		label: string;
		availability: PublicChatEnabledModelCatalogSummary["videoModels"][number]["availability"];
		pricingCost: number | null;
		useCases: string[];
		durationOptions: number[];
		defaultDurationSeconds: number | null;
		maxDurationSeconds: number | null;
		defaultResolution: string | null;
		resolutionOptions: string[];
		sizeOptions: string[];
		orientationOptions: string[];
		/** sizeOptions/orientationOptions 中真实声明过的画幅去重结果；未声明时为空数组。 */
		aspectRatioOptions: string[];
		maxReferenceImages: number | null;
		maxReferenceAudios: number | null;
		supportsNativeAudio: boolean | null;
	}>;
};

export type AgentAudioExecutionCatalog = {
	kind: "audio";
	fetchedAt: string;
	revision: string;
	selectionContract: string;
	models: Array<{
		modelKey: string;
		label: string;
		audioType: "speech" | "music";
		engine: string | null;
		pricingCost: number;
	}>;
};

export type AgentMediaExecutionCatalog = {
	fetchedAt: string;
	image: AgentImageExecutionCatalog;
	video: AgentVideoExecutionCatalog;
	audio: AgentAudioExecutionCatalog;
};

/**
 * 视频侧只暴露实时目录里真实可执行的精确 modelKey 与其物理档位。
 * 调用方必须原样把 modelKey 提交给 film_video_gen 的 ai_model；
 * 该 modelKey 同时是执行器解析 vendor 的唯一依据（comfyui 目录命中即本地执行）。
 */
export function buildAgentVideoExecutionCatalog(
	summary: PublicChatEnabledModelCatalogSummary,
	fetchedAt: string,
): AgentVideoExecutionCatalog {
	const models = summary.videoModels.map((model) => {
		const videoOptions = model.videoOptions;
		const sizeOptions = videoOptions?.sizeOptions.map((option) => option.value) ?? [];
		const orientationOptions = videoOptions?.orientationOptions.map((option) => option.value) ?? [];
		// 画幅只从目录真实声明里收集：sizeOptions.aspectRatio 与 orientationOptions.aspectRatio。
		const aspectRatioOptions = [...new Set([
			...(videoOptions?.sizeOptions ?? []).flatMap((option) => option.aspectRatio ? [option.aspectRatio] : []),
			...(videoOptions?.orientationOptions ?? []).flatMap((option) => option.aspectRatio ? [option.aspectRatio] : []),
		])];
		return {
			modelKey: model.modelKey,
			modelAlias: model.modelAlias,
			vendorKey: model.vendorKey,
			label: model.labelZh,
			availability: model.availability,
			pricingCost: model.pricingCost,
			useCases: model.useCases,
			durationOptions: videoOptions?.durationOptions.map((option) => option.value) ?? [],
			defaultDurationSeconds: videoOptions?.defaultDurationSeconds ?? null,
			maxDurationSeconds: videoOptions?.maxDurationSeconds ?? null,
			defaultResolution: videoOptions?.defaultResolution ?? null,
			resolutionOptions: videoOptions?.resolutionOptions.map((option) => option.value) ?? [],
			sizeOptions,
			orientationOptions,
			aspectRatioOptions,
			maxReferenceImages: videoOptions?.maxReferenceImages ?? null,
			maxReferenceAudios: videoOptions?.maxReferenceAudios ?? null,
			supportsNativeAudio: videoOptions?.supportsNativeAudio ?? null,
		};
	});
	return {
		kind: "video",
		fetchedAt,
		revision: stableContentHash(models),
		selectionContract:
			"Pass one exact modelKey from this list as film_video_gen.ai_model, and keep it identical across every shot of one film. When durationOptions is declared, duration_sec must be one of them; when resolutionOptions/aspectRatioOptions are declared, resolution/aspect_ratio must be exact supported values. Never invent, translate, shorten, substitute, or silently default a model identity or media specification.",
		models,
	};
}

/**
 * 音频侧的默认执行器由目录声明的引擎标签解析：speech 且 engine=minimax-h3 时
 * film_audio_gen 省略 ai_model 即走本机 H3。models 里的 modelKey 同样可显式传入。
 */
export function buildAgentAudioExecutionCatalog(
	summary: PublicChatEnabledModelCatalogSummary,
	fetchedAt: string,
): AgentAudioExecutionCatalog {
	const models = summary.audioModels.map((model) => ({
		modelKey: model.modelKey,
		label: model.label,
		audioType: model.audioType,
		engine: model.engine,
		pricingCost: model.pricingCost,
	}));
	return {
		kind: "audio",
		fetchedAt,
		revision: stableContentHash(models),
		selectionContract:
			"film_audio_gen may omit ai_model only when this list declares exactly one speech model whose engine is minimax-h3; otherwise pass one exact modelKey from this list. Music generation must use a modelKey whose audioType is music. Never invent or substitute an engine or model identity.",
		models,
	};
}

export function buildAgentMediaExecutionCatalog(
	summary: PublicChatEnabledModelCatalogSummary,
	fetchedAt: string,
): AgentMediaExecutionCatalog {
	return {
		fetchedAt,
		image: buildAgentImageExecutionCatalog(summary, fetchedAt),
		video: buildAgentVideoExecutionCatalog(summary, fetchedAt),
		audio: buildAgentAudioExecutionCatalog(summary, fetchedAt),
	};
}

export type AgentLocalModelCatalogRow = {
	modelKey: string;
	modelAlias: string | null;
	vendorKey: string;
	labelZh: string;
	pricingCost: number | null;
	meta: unknown;
};

function readRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
}

/**
 * 从目录项的 videoOptions 抽取合法时长档位。
 * 管理后台同时存在两种等价写法：数字数组（`[1,2,3]`）与对象数组（`[{value,label}]`）。
 * 两者都必须被接受；其他形态不构成合法档位证据，直接跳过而不是猜测。
 */
function readDeclaredDurationOptions(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	const out: number[] = [];
	for (const item of value) {
		const candidate =
			typeof item === "number"
				? item
				: readRecord(item).value;
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
			out.push(Math.trunc(candidate));
		}
	}
	return [...new Set(out)].sort((a, b) => a - b);
}

function readDeclaredStringOptions(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.flatMap((item) => {
		if (typeof item === "string" && item.trim()) return [item.trim()];
		const record = readRecord(item);
		const candidate = record.value;
		return typeof candidate === "string" && candidate.trim() ? [candidate.trim()] : [];
	}))];
}

/**
 * 本地执行器（ComfyUI 等）的真实视频目录投影。
 *
 * 数据源必须与执行器解析 vendor 时查询的一致：`model_catalog_models` 里
 * 声明了 videoOptions 的启用视频模型。new-api 运行时目录只覆盖系统渠道模型，
 * 本地 ComfyUI 模型不会出现在其中，因此不能用它来判定本地模型是否可执行。
 */
export function buildAgentLocalVideoExecutionCatalog(
	rows: readonly AgentLocalModelCatalogRow[],
	fetchedAt: string,
): AgentVideoExecutionCatalog {
	const models = rows.map((row) => {
		const videoOptions = readRecord(readRecord(row.meta).videoOptions);
		const sizeOptions = readDeclaredStringOptions(videoOptions.sizeOptions);
		const orientationOptions = readDeclaredStringOptions(videoOptions.orientationOptions);
		const aspectRatioOptions = [...new Set([
			...sizeOptions.filter((value) => value.includes(":")),
			...orientationOptions.filter((value) => value.includes(":")),
		])];
		const durationOptions = readDeclaredDurationOptions(videoOptions.durationOptions);
		return {
			modelKey: row.modelKey,
			modelAlias: row.modelAlias,
			vendorKey: row.vendorKey,
			label: row.labelZh,
			availability: "system" as const,
			pricingCost: row.pricingCost,
			useCases: readStringArray(readRecord(row.meta).useCases),
			durationOptions,
			defaultDurationSeconds:
				typeof videoOptions.defaultDurationSeconds === "number"
					? videoOptions.defaultDurationSeconds
					: null,
			maxDurationSeconds: durationOptions.length ? durationOptions[durationOptions.length - 1]! : null,
			defaultResolution:
				typeof videoOptions.defaultResolution === "string" && videoOptions.defaultResolution.trim()
					? videoOptions.defaultResolution.trim()
					: null,
			resolutionOptions: readDeclaredStringOptions(videoOptions.resolutionOptions),
			sizeOptions,
			orientationOptions,
			aspectRatioOptions,
			maxReferenceImages:
				typeof videoOptions.maxReferenceImages === "number" ? videoOptions.maxReferenceImages : null,
			maxReferenceAudios:
				typeof videoOptions.maxReferenceAudios === "number" ? videoOptions.maxReferenceAudios : null,
			supportsNativeAudio:
				typeof videoOptions.supportsNativeAudio === "boolean" ? videoOptions.supportsNativeAudio : null,
		};
	});
	return {
		kind: "video",
		fetchedAt,
		revision: stableContentHash(models),
		selectionContract:
			"Pass one exact modelKey from this list as film_video_gen.ai_model, and keep it identical across every shot of one film. When durationOptions is declared, duration_sec must be one of them; when resolutionOptions/aspectRatioOptions are declared, resolution/aspect_ratio must be exact supported values. Never invent, translate, shorten, substitute, or silently default a model identity or media specification.",
		models,
	};
}

/**
 * 本地执行器的真实音频目录投影。
 * 引擎与音频类型只从目录项声明的能力标签读取（`tapcanvas:audio-engine=*`、
 * `tapcanvas:audio-type=*`），不按模型名称推断。
 */
export function buildAgentLocalAudioExecutionCatalog(
	rows: readonly AgentLocalModelCatalogRow[],
	fetchedAt: string,
): AgentAudioExecutionCatalog {
	const models = rows.flatMap((row) => {
		const tags = readStringArray(readRecord(row.meta).tags).map((tag) => tag.toLowerCase());
		const audioType = tags.includes("tapcanvas:audio-type=speech")
			? "speech" as const
			: tags.includes("tapcanvas:audio-type=music")
				? "music" as const
				: null;
		if (!audioType) return [];
		const engineTag = tags.find((tag) => tag.startsWith("tapcanvas:audio-engine="));
		return [{
			modelKey: row.modelKey,
			label: row.labelZh,
			audioType,
			engine: engineTag ? engineTag.slice("tapcanvas:audio-engine=".length) || null : null,
			pricingCost: row.pricingCost ?? 0,
		}];
	});
	return {
		kind: "audio",
		fetchedAt,
		revision: stableContentHash(models),
		selectionContract:
			"film_audio_gen may omit ai_model only when this list declares exactly one speech model whose engine is minimax-h3; otherwise pass one exact modelKey from this list. Music generation must use a modelKey whose audioType is music. Never invent or substitute an engine or model identity.",
		models,
	};
}

/**
 * 本地执行器的真实图片目录投影：只使用目录项自身声明的 imageOptions，
 * 不借用系统渠道模型的运行时元数据。
 */
export function buildAgentLocalImageExecutionCatalog(
	rows: readonly AgentLocalModelCatalogRow[],
	fetchedAt: string,
): AgentImageExecutionCatalog {
	const models = rows.map((row) => {
		const imageOptions = readRecord(readRecord(row.meta).imageOptions);
		const aspectRatioOptions = readDeclaredStringOptions(imageOptions.aspectRatioOptions);
		const imageSizeOptions = readDeclaredStringOptions(imageOptions.imageSizeOptions);
		return {
			modelKey: row.modelKey,
			label: row.labelZh,
			pricingCost: row.pricingCost,
			imageOptions: aspectRatioOptions.length || imageSizeOptions.length
				? {
					defaultAspectRatio:
						typeof imageOptions.defaultAspectRatio === "string" ? imageOptions.defaultAspectRatio : null,
					defaultImageSize:
						typeof imageOptions.defaultImageSize === "string" ? imageOptions.defaultImageSize : null,
					aspectRatioOptions,
					imageSizeOptions: imageSizeOptions.map((value) => ({
						value,
						label: value,
						priceLabel: null,
					})),
					resolutionOptions: readDeclaredStringOptions(imageOptions.resolutionOptions),
					maxReferenceImages:
						typeof imageOptions.maxReferenceImages === "number" ? imageOptions.maxReferenceImages : null,
					supportsReferenceImages:
						typeof imageOptions.supportsReferenceImages === "boolean" ? imageOptions.supportsReferenceImages : null,
					supportsTextToImage:
						typeof imageOptions.supportsTextToImage === "boolean" ? imageOptions.supportsTextToImage : null,
					supportsImageToImage:
						typeof imageOptions.supportsImageToImage === "boolean" ? imageOptions.supportsImageToImage : null,
				}
				: null,
		};
	});
	return {
		kind: "image",
		fetchedAt,
		revision: stableContentHash(models),
		selectionContract:
			"Set node.data.imageModel to one exact modelKey from this list. When the selected model declares imageOptions, set node.data.aspect and node.data.imageSize to exact supported values. Never invent, translate, shorten, substitute, or silently default a model identity or media specification.",
		models,
	};
}
