import { AppError } from "../../middleware/error";
import type { AppContext } from "../../types";
import { getPrismaClient } from "../../platform/node/prisma";
import { ensureModelCatalogSchema } from "../model-catalog/model-catalog.repo";
import { TaskAssetSchema, TaskResultSchema, type TaskRequestDto, type TaskResultDto } from "./task.schemas";

type JsonRecord = Record<string, unknown>;
type ComfyNode = { class_type?: unknown; inputs?: JsonRecord };
type ComfyWorkflow = Record<string, ComfyNode>;

type WorkflowVariant = {
	id: string;
	name?: string;
	capability?: string;
	taskKind: "text_to_image" | "image_edit";
	referenceImageCount: number;
	workflow: ComfyWorkflow;
	promptNodeIds?: string[];
	imageNodeIds?: string[];
	outputNodeIds?: string[];
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
		const taskKind = raw.taskKind === "text_to_image" || raw.taskKind === "image_edit" ? raw.taskKind : null;
		const count = typeof raw.referenceImageCount === "number" && Number.isInteger(raw.referenceImageCount) && raw.referenceImageCount >= 0 ? raw.referenceImageCount : null;
		if (!id || !taskKind || count === null) throw new AppError(`ComfyUI 工作流变体 ${index + 1} 缺少 id/taskKind/referenceImageCount`, { status: 500, code: "comfyui_workflow_config_invalid" });
		const promptNodeIds = Array.isArray(raw.promptNodeIds) ? raw.promptNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const imageNodeIds = Array.isArray(raw.imageNodeIds) ? raw.imageNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const outputNodeIds = Array.isArray(raw.outputNodeIds) ? raw.outputNodeIds.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim()) : undefined;
		const capability = readString(raw.capability);
		variants.push({ id, name: readString(raw.name) || undefined, ...(capability ? { capability } : {}), taskKind, referenceImageCount: count, workflow: parseWorkflow(raw.workflow, `ComfyUI 工作流变体 ${id}`), ...(promptNodeIds?.length ? { promptNodeIds } : {}), ...(imageNodeIds?.length ? { imageNodeIds } : {}), ...(outputNodeIds?.length ? { outputNodeIds } : {}) });
	}
	return { workflowVariants: variants };
}

export function selectComfyUiWorkflowVariant(
	config: ComfyConfig,
	input: { modelKey: string; taskKind: WorkflowVariant["taskKind"]; referenceImageCount: number; capability?: string },
): WorkflowVariant {
	const matches = config.workflowVariants.filter((variant) => variant.taskKind === input.taskKind && variant.referenceImageCount === input.referenceImageCount && (!input.capability || variant.capability === input.capability));
	if (matches.length !== 1) throw new AppError(`ComfyUI 工作流无法唯一匹配：${input.modelKey}/${input.taskKind}/参考图${input.referenceImageCount}张`, { status: 400, code: "comfyui_workflow_route_not_unique", details: { modelKey: input.modelKey, taskKind: input.taskKind, referenceImageCount: input.referenceImageCount, matches: matches.map((variant) => variant.id) } });
	return matches[0]!;
}

async function resolveVariant(c: AppContext, modelKey: string, taskKind: WorkflowVariant["taskKind"], referenceImageCount: number, capability?: string): Promise<WorkflowVariant> {
	await ensureModelCatalogSchema(c.env.DB);
	const rows = await getPrismaClient().model_catalog_models.findMany({ where: { vendor_key: "comfyui", enabled: 1, OR: [{ model_key: modelKey }, { model_alias: modelKey }] }, select: { model_key: true, meta: true } });
	if (rows.length !== 1) throw new AppError(`ComfyUI 模型 ${modelKey} 不存在或匹配不唯一`, { status: 400, code: "comfyui_model_not_unique", details: { modelKey, matches: rows.map((row) => row.model_key) } });
	let meta: unknown = null;
	try { meta = rows[0]?.meta ? JSON.parse(rows[0].meta) as unknown : null; } catch { throw new AppError(`ComfyUI 模型 ${modelKey} 的 meta 不是合法 JSON`, { status: 500, code: "comfyui_model_meta_invalid" }); }
	return selectComfyUiWorkflowVariant(parseComfyUiWorkflowConfig(meta, modelKey), { modelKey, taskKind, referenceImageCount, ...(capability ? { capability } : {}) });
}

function cloneWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
	return JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
}

function discoverNodeIds(workflow: ComfyWorkflow, kind: "prompt" | "image" | "output"): string[] {
	return Object.entries(workflow).filter(([, node]) => {
		const classType = readString(node.class_type).toLowerCase();
		if (kind === "prompt") return isRecord(node.inputs) && Object.prototype.hasOwnProperty.call(node.inputs, "text") && classType.includes("text");
		if (kind === "image") return classType === "loadimage";
		return classType === "saveimage" || classType === "saveimageadvanced" || classType === "previewimage";
	}).map(([id]) => id);
}

function applyWorkflowInputs(variant: WorkflowVariant, request: TaskRequestDto, uploadedNames: readonly string[]): ComfyWorkflow {
	const workflow = cloneWorkflow(variant.workflow);
	const promptIds = variant.promptNodeIds ?? discoverNodeIds(workflow, "prompt");
	if (promptIds.length === 0) throw new AppError(`ComfyUI 工作流 ${variant.id} 未找到提示词节点`, { status: 500, code: "comfyui_prompt_node_missing" });
	for (const id of promptIds) {
		const inputs = workflow[id]?.inputs;
		if (!inputs) throw new AppError(`ComfyUI 提示词节点 ${id} 不存在`, { status: 500, code: "comfyui_prompt_node_invalid" });
		inputs.text = request.prompt;
	}
	const imageIds = variant.imageNodeIds ?? discoverNodeIds(workflow, "image");
	if (imageIds.length !== uploadedNames.length) throw new AppError(`ComfyUI 工作流 ${variant.id} 的参考图节点数与输入不一致`, { status: 400, code: "comfyui_reference_node_mismatch", details: { expected: imageIds.length, received: uploadedNames.length } });
	for (let index = 0; index < imageIds.length; index += 1) {
		const inputs = workflow[imageIds[index]!]!.inputs;
		if (!inputs) throw new AppError(`ComfyUI 图片节点 ${imageIds[index]} 无 inputs`, { status: 500, code: "comfyui_image_node_invalid" });
		inputs.image = uploadedNames[index]!;
	}
	return workflow;
}

async function uploadReferenceImage(baseUrl: string, token: string, url: string, index: number): Promise<string> {
	const source = await fetch(url);
	if (!source.ok) throw new AppError(`ComfyUI 参考图下载失败：${source.status}`, { status: 502, code: "comfyui_reference_fetch_failed" });
	const blob = await source.blob();
	const form = new FormData();
	form.append("image", blob, `tapcanvas-reference-${index + 1}.png`);
	form.append("overwrite", "true");
	const response = await fetch(comfyUrl(baseUrl, "upload/image"), { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: form });
	if (!response.ok) throw new AppError(`ComfyUI 参考图上传失败：${response.status}`, { status: 502, code: "comfyui_upload_failed" });
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !readString(payload.name)) throw new AppError("ComfyUI 上传响应缺少 name", { status: 502, code: "comfyui_upload_response_invalid" });
	return readString(payload.name);
}

async function runComfyRequest(baseUrl: string, token: string, workflow: ComfyWorkflow): Promise<{ promptId: string; response: unknown }> {
	const response = await fetch(comfyUrl(baseUrl, "prompt"), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ prompt: workflow, client_id: `tapcanvas-${crypto.randomUUID()}` }) });
	const payload: unknown = await response.json();
	if (!response.ok) throw new AppError(`ComfyUI 提交失败：${response.status}`, { status: 502, code: "comfyui_prompt_failed", details: { response: payload } });
	if (!isRecord(payload) || !readString(payload.prompt_id)) throw new AppError("ComfyUI 提交响应缺少 prompt_id", { status: 502, code: "comfyui_prompt_response_invalid" });
	return { promptId: readString(payload.prompt_id), response: payload };
}

async function waitForComfyHistory(baseUrl: string, token: string, promptId: string, timeoutMs: number): Promise<JsonRecord> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const response = await fetch(comfyUrl(baseUrl, `history/${encodeURIComponent(promptId)}`), { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
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
		for (const key of ["images", "gifs"] as const) {
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
	const taskKind: WorkflowVariant["taskKind"] = references.length ? "image_edit" : "text_to_image";
	const capability = readString(extras.workflowCapability) || readString(extras.libTvImagePresetKey) || undefined;
	const variant = await resolveVariant(c, modelKey, taskKind, references.length, capability);
	const uploadedNames: string[] = [];
	for (let index = 0; index < references.length; index += 1) uploadedNames.push(await uploadReferenceImage(baseUrl, token, references[index]!, index));
	const workflow = applyWorkflowInputs(variant, req, uploadedNames);
	const submitted = await runComfyRequest(baseUrl, token, workflow);
	const history = await waitForComfyHistory(baseUrl, token, submitted.promptId, Number(readEnv(c, "COMFYUI_POLL_TIMEOUT_MS")) || 600000);
	const files = extractOutputFiles(history, variant, workflow);
	if (!files.length) throw new AppError(`ComfyUI 工作流 ${variant.id} 未产出图片`, { status: 502, code: "comfyui_output_missing", details: { promptId: submitted.promptId } });
	const assets = [];
	for (const file of files) {
		const url = comfyUrl(baseUrl, `view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder)}&type=${encodeURIComponent(file.type)}`);
		assets.push(TaskAssetSchema.parse({ type: "image", url }));
	}
	return TaskResultSchema.parse({ id: submitted.promptId, kind: req.kind, status: "succeeded", assets, raw: { provider: "comfyui", modelKey, workflowVariant: variant.id, promptId: submitted.promptId, response: submitted.response, history } });
}
