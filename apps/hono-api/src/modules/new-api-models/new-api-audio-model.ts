import { AppError } from "../../middleware/error";
import type { AppContext } from "../../types";
import {
	isSelectableNewApiModel,
	listNewApiModels,
	type NewApiModelDto,
} from "./new-api-models.service";
import type { ModelParamSpec } from "../model-catalog/model-catalog.schemas";
import { listModelCatalogModels, listModelCatalogVendors } from "../model-catalog/model-catalog.service";

export type AudioCatalogType = "speech" | "music";
export type AudioRuntimeParameterValue = string | number | boolean;
export type AudioRuntimeParameters = Record<string, AudioRuntimeParameterValue>;

function normalizeIdentifier(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const AUDIO_TYPE_TAG_PREFIX = "tapcanvas:audio-type=";
const AUDIO_ENGINE_TAG_PREFIX = "tapcanvas:audio-engine=";

function catalogAudioType(model: Pick<NewApiModelDto, "tags">): AudioCatalogType | null {
	for (const rawTag of model.tags) {
		const tag = rawTag.trim().toLowerCase();
		if (tag === `${AUDIO_TYPE_TAG_PREFIX}speech`) return "speech";
		if (tag === `${AUDIO_TYPE_TAG_PREFIX}music`) return "music";
	}
	return null;
}

export function readAudioCatalogEngine(model: Pick<NewApiModelDto, "tags">): string {
	for (const rawTag of model.tags) {
		const tag = rawTag.trim().toLowerCase();
		if (tag.startsWith(AUDIO_ENGINE_TAG_PREFIX)) {
			return tag.slice(AUDIO_ENGINE_TAG_PREFIX.length).trim();
		}
	}
	return "";
}

function findCatalogAudioModel(
	models: NewApiModelDto[],
	requestedModel: string,
): NewApiModelDto | null {
	const requested = normalizeIdentifier(requestedModel);
	if (!requested) return null;
	return models.find((model) =>
		[model.modelName, model.requestModelKey]
			.map(normalizeIdentifier)
			.includes(requested),
	) ?? null;
}

async function listSelectableAudioModels(
	c: AppContext,
	fresh: boolean,
): Promise<NewApiModelDto[]> {
	const models = await listNewApiModels(c.env, {
		enabled: true,
		kind: "audio",
		...(fresh ? { fresh: true } : {}),
	});
	const runtimeModels = models.filter(isSelectableNewApiModel);
	const [configured, vendors] = await Promise.all([
		listModelCatalogModels(c, { kind: "audio", enabled: true }),
		listModelCatalogVendors(c),
	]);
	const enabledVendors = new Set(vendors.filter((vendor) => vendor.enabled).map((vendor) => vendor.key.trim().toLowerCase()));
	const configuredModels: NewApiModelDto[] = configured.flatMap((model, index) => {
		const vendorKey = model.vendorKey.trim().toLowerCase();
		if (!enabledVendors.has(vendorKey)) return [];
		const meta = model.meta && typeof model.meta === "object" && !Array.isArray(model.meta)
			? model.meta as Record<string, unknown>
			: {};
		const tags = Array.isArray(meta.tags)
			? meta.tags.filter((tag): tag is string => typeof tag === "string")
			: [];
		if (!catalogAudioType({ tags })) return [];
		return [{
			id: -(index + 1),
			modelName: model.modelAlias?.trim() || model.modelKey,
			requestModelKey: model.modelKey,
			routingAliases: [],
			displayLabel: model.labelZh,
			description: null,
			icon: null,
			tags,
			vendorId: null,
			endpoints: [vendorKey],
			runtimeEndpoints: [vendorKey],
			kind: "audio",
			enabled: true,
			syncOfficial: false,
			nameRule: 0,
			createdTime: Date.parse(model.createdAt) || 0,
			updatedTime: Date.parse(model.updatedAt) || 0,
			meta,
			pricing: model.pricing,
		}];
	});
	return [...runtimeModels, ...configuredModels];
}

/**
 * Resolve an exact, currently executable audio model from the system catalog.
 * A second fresh read only invalidates the catalog cache after an administrative
 * update; it never substitutes another model or audio type.
 */
export async function requireSelectableAudioModel(
	c: AppContext,
	requestedModelValue: unknown,
	expectedType: AudioCatalogType,
): Promise<NewApiModelDto> {
	const requestedModel = typeof requestedModelValue === "string"
		? requestedModelValue.trim()
		: "";
	if (!requestedModel) {
		throw new AppError("音频生成必须指定系统模型目录返回的精确 audioModel", {
			status: 400,
			code: "audio_model_required",
			details: { expectedType },
		});
	}

	let models = await listSelectableAudioModels(c, false);
	let matched = findCatalogAudioModel(models, requestedModel);
	if (!matched) {
		models = await listSelectableAudioModels(c, true);
		matched = findCatalogAudioModel(models, requestedModel);
	}
	if (!matched) {
		throw new AppError("音频模型已停用、未定价或没有有效渠道协议", {
			status: 400,
			code: "audio_model_unavailable",
			details: { requestedModel, expectedType },
		});
	}

	const actualType = catalogAudioType(matched);
	if (actualType !== expectedType) {
		throw new AppError("音频模型类型与当前生成任务不匹配", {
			status: 400,
			code: "audio_model_type_mismatch",
			details: {
				requestedModel,
				expectedType,
				actualType,
			},
		});
	}
	return matched;
}

/**
 * 默认执行器解析：调用方没有指定 audioModel 时，只按实时音频目录里已声明的能力标签
 * 选择 MiniMax H3 语音模型（`tapcanvas:audio-type=speech` + `tapcanvas:audio-engine=minimax-h3`）。
 *
 * 这里不做任何隐式兜底：目录未声明该能力时显式失败，声明多个候选时同样显式失败并回报候选，
 * 由调用方给出精确 modelKey；不会退回到别的引擎或别的模型。
 */
export async function requireDefaultMiniMaxH3SpeechModel(
	c: AppContext,
): Promise<NewApiModelDto> {
	const collectCandidates = async (fresh: boolean): Promise<NewApiModelDto[]> => {
		const models = await listSelectableAudioModels(c, fresh);
		return models.filter(
			(model) =>
				catalogAudioType(model) === "speech" &&
				readAudioCatalogEngine(model) === "minimax-h3",
		);
	};
	let candidates = await collectCandidates(false);
	if (candidates.length === 0) candidates = await collectCandidates(true);
	if (candidates.length === 0) {
		throw new AppError(
			"当前音频模型目录没有声明 MiniMax H3 语音模型，无法使用默认执行器；请显式传入目录中的精确 audioModel",
			{
				status: 409,
				code: "audio_default_model_unavailable",
				details: { expectedEngine: "minimax-h3", expectedType: "speech" },
			},
		);
	}
	if (candidates.length > 1) {
		throw new AppError(
			"当前音频模型目录声明了多个 MiniMax H3 语音模型，无法确定默认执行器；请显式传入精确 audioModel",
			{
				status: 409,
				code: "audio_default_model_ambiguous",
				details: {
					expectedEngine: "minimax-h3",
					expectedType: "speech",
					candidates: candidates.map((model) => model.requestModelKey).sort(),
				},
			},
		);
	}
	return candidates[0]!;
}

function readRuntimeParameterSpecs(model: Pick<NewApiModelDto, "meta">): ModelParamSpec[] {
	const parameters = model.meta?.runtimeParameters;
	return Array.isArray(parameters) ? parameters : [];
}

function isRuntimeParameterValue(value: unknown): value is AudioRuntimeParameterValue {
	return typeof value === "string" || typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value));
}

function isRuntimeParameterValueValid(
	parameter: ModelParamSpec,
	value: AudioRuntimeParameterValue,
): boolean {
	if (parameter.type === "boolean") return typeof value === "boolean";
	if (parameter.type === "string") return typeof value === "string";
	if (parameter.type === "enum") {
		return parameter.options?.some((option) => option.value === value) === true;
	}
	if (typeof value !== "number") return false;
	if (parameter.type === "integer" && !Number.isInteger(value)) return false;
	if (typeof parameter.min === "number" && value < parameter.min) return false;
	if (typeof parameter.max === "number" && value > parameter.max) return false;
	return true;
}

/**
 * 只接受当前目录项声明的参数。这里是音频配置的唯一服务端边界，禁止把未知字段
 * 静默透传给某个执行引擎，避免模型切换后沿用不兼容的旧参数。
 */
export function validateAudioRuntimeParameters(
	model: Pick<NewApiModelDto, "meta" | "modelName">,
	rawValue: unknown,
): AudioRuntimeParameters {
	if (rawValue === undefined || rawValue === null) return {};
	if (typeof rawValue !== "object" || Array.isArray(rawValue)) {
		throw new AppError("音频 runtimeParameters 必须是对象", {
			status: 400,
			code: "audio_runtime_parameters_invalid",
		});
	}

	const raw = rawValue as Record<string, unknown>;
	const specs = readRuntimeParameterSpecs(model);
	const specsByKey = new Map(specs.map((parameter) => [parameter.key, parameter]));
	const result: AudioRuntimeParameters = {};

	for (const [key, value] of Object.entries(raw)) {
		const parameter = specsByKey.get(key);
		if (!parameter) {
			throw new AppError("音频参数未在当前模型目录中声明", {
				status: 400,
				code: "audio_runtime_parameter_unknown",
				details: { model: model.modelName, key },
			});
		}
		if (!isRuntimeParameterValue(value) || !isRuntimeParameterValueValid(parameter, value)) {
			throw new AppError("音频参数值不符合当前模型目录约束", {
				status: 400,
				code: "audio_runtime_parameter_invalid",
				details: { model: model.modelName, key, type: parameter.type },
			});
		}
		result[key] = value;
	}

	for (const parameter of specs) {
		if (result[parameter.key] !== undefined) continue;
		if (isRuntimeParameterValue(parameter.default) && isRuntimeParameterValueValid(parameter, parameter.default)) {
			result[parameter.key] = parameter.default;
			continue;
		}
		if (parameter.required) {
			throw new AppError("音频模型缺少必填参数", {
				status: 400,
				code: "audio_runtime_parameter_required",
				details: { model: model.modelName, key: parameter.key },
			});
		}
	}

	return result;
}
