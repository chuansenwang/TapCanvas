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

function catalogAudioType(model: Pick<NewApiModelDto, "tags">): AudioCatalogType | null {
	for (const rawTag of model.tags) {
		const tag = rawTag.trim().toLowerCase();
		if (tag === "tapcanvas:audio-type=speech") return "speech";
		if (tag === "tapcanvas:audio-type=music") return "music";
	}
	return null;
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
