import { describe, expect, it } from "vitest";
import {
	applyComfyUiWorkflowInputs,
	parseComfyUiWorkflowConfig,
	resolveComfyUiSeed,
	selectComfyUiWorkflowVariant,
} from "./comfyui-workflow";

const workflow = {
	"1": { class_type: "CLIPTextEncode", inputs: { text: "old", clip: ["2", 0] } },
	"2": { class_type: "LoadImage", inputs: { image: "old.png" } },
	"3": { class_type: "SaveImage", inputs: { images: ["4", 0] } },
};

const seededWorkflow = {
	"10": { class_type: "RandomNoise", inputs: { noise_seed: 123 } },
	"11": { class_type: "KSampler", inputs: { seed: 456 } },
	"12": { class_type: "CLIPTextEncode", inputs: { text: "old", clip: ["13", 0] } },
};

describe("ComfyUI 工作流目录", () => {
	it("支持 H3 多媒体工作流并按类型写入 media_state", () => {
		const h3Variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [
			{ id: "h3", taskKind: "text_to_video", referenceImageCount: 0, mediaLoaderNodeIds: ["42"], promptNodeIds: ["3"], outputNodeIds: ["21"], outputMediaType: "video", workflow: {
				"3": { class_type: "MiniMaxH3Easy", inputs: { prompt: "old", resolution: "360P" } },
				"42": { class_type: "MiniMaxH3EasyMediaLoader", inputs: { media_state: "{}" } },
				"9": { class_type: "RandomNoise", inputs: { noise_seed: 1 } },
				"21": { class_type: "SaveVideo", inputs: {} },
			} },
		] } }, "minimax-h3").workflowVariants[0]!;
		const result = applyComfyUiWorkflowInputs(h3Variant, { kind: "text_to_video", prompt: "生成视频", extras: { resolution: "720P", durationSeconds: 6 } }, [], 9, [
			{ type: "audio", url: "https://example.test/a.mp3", filename: "a.mp3" },
			{ type: "image", url: "https://example.test/i.png", filename: "i.png" },
			{ type: "video", url: "https://example.test/v.mp4", filename: "v.mp4" },
		]);
		expect(result["3"]?.inputs?.prompt).toBe("生成视频");
		expect(result["3"]?.inputs?.resolution).toBe("720P");
		expect(result["3"]?.inputs?.seconds).toBe(6);
		expect(JSON.parse(String(result["42"]?.inputs?.media_state))).toEqual({ images: [{ filename: "i.png" }], audios: [{ filename: "a.mp3" }], videos: [{ filename: "v.mp4" }] });
	});

	it("H3 工作流没有媒体时显式失败", () => {
		const h3Variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{ id: "h3", taskKind: "text_to_video", referenceImageCount: 0, workflow: { "3": { class_type: "MiniMaxH3Easy", inputs: { prompt: "old" } }, "42": { class_type: "MiniMaxH3EasyMediaLoader", inputs: { media_state: "{}" } } } }] } }, "minimax-h3").workflowVariants[0]!;
		expect(() => applyComfyUiWorkflowInputs(h3Variant, { kind: "text_to_video", prompt: "生成视频", extras: {} }, [], 1)).toThrow("缺少媒体输入");
	});
	it("解析并按任务类型和参考图数量唯一选择变体", () => {
		const config = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [
			{ id: "txt", taskKind: "text_to_image", referenceImageCount: 0, workflow },
			{ id: "edit-1", taskKind: "image_edit", referenceImageCount: 1, workflow },
		] } }, "klein9b");
		expect(selectComfyUiWorkflowVariant(config, { modelKey: "klein9b", taskKind: "image_edit", referenceImageCount: 1 }).id).toBe("edit-1");
	});

	it("匹配不唯一时显式失败", () => {
		const config = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [
			{ id: "a", taskKind: "text_to_image", referenceImageCount: 0, workflow },
			{ id: "b", taskKind: "text_to_image", referenceImageCount: 0, workflow },
		] } }, "klein9b");
		expect(() => selectComfyUiWorkflowVariant(config, { modelKey: "klein9b", taskKind: "text_to_image", referenceImageCount: 0 })).toThrow("无法唯一匹配");
	});

	it("能力字段可以消除同一参考图数量下的歧义", () => {
		const config = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [
			{ id: "edit", taskKind: "image_edit", referenceImageCount: 1, workflow },
			{ id: "character-3view", capability: "character-3view", taskKind: "image_edit", referenceImageCount: 1, workflow },
		] } }, "klein9b");
		expect(selectComfyUiWorkflowVariant(config, { modelKey: "klein9b", taskKind: "image_edit", referenceImageCount: 1, capability: "character-3view" }).id).toBe("character-3view");
	});

	it("允许用明确的变体 id 选择普通单图编辑", () => {
		const config = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [
			{ id: "edit-1", taskKind: "image_edit", referenceImageCount: 1, workflow },
			{ id: "character-3view", capability: "character-3view", taskKind: "image_edit", referenceImageCount: 1, workflow },
		] } }, "klein9b");
		expect(selectComfyUiWorkflowVariant(config, {
			modelKey: "klein9b", taskKind: "image_edit", referenceImageCount: 1, capability: "edit-1",
		}).id).toBe("edit-1");
	});

	it("缺少工作流目录时显式失败", () => {
		expect(() => parseComfyUiWorkflowConfig({}, "klein9b")).toThrow("未配置 workflowVariants");
	});

	it("每次未指定种子时刷新工作流中的随机节点，并支持显式种子复现", () => {
		const variant = {
			id: "txt",
			taskKind: "text_to_image" as const,
			referenceImageCount: 0,
			workflow: seededWorkflow,
		};
		const first = applyComfyUiWorkflowInputs(variant, {
			kind: "text_to_image",
			prompt: "生成一张图",
			extras: {},
		}, [], 1001);
		const second = applyComfyUiWorkflowInputs(variant, {
			kind: "text_to_image",
			prompt: "生成一张图",
			extras: {},
		}, [], 2002);
		const explicit = applyComfyUiWorkflowInputs(variant, {
			kind: "text_to_image",
			prompt: "生成一张图",
			seed: 3003,
			extras: {},
		}, [], 3003);

		expect(first["10"]?.inputs?.noise_seed).toBe(1001);
		expect(first["11"]?.inputs?.seed).toBe(1001);
		expect(second["10"]?.inputs?.noise_seed).toBe(2002);
		expect(second["11"]?.inputs?.seed).toBe(2002);
		expect(explicit["10"]?.inputs?.noise_seed).toBe(3003);
		expect(explicit["11"]?.inputs?.seed).toBe(3003);
	});

	it("未指定种子时从新的随机源取种子，显式种子保持不变", () => {
		expect(resolveComfyUiSeed({
			kind: "text_to_image",
			prompt: "生成一张图",
			extras: {},
		}, () => "00000000-0010-0000-0000-000000000001")).toBe(16);
		expect(resolveComfyUiSeed({
			kind: "text_to_image",
			prompt: "生成一张图",
			seed: 42.9,
			extras: {},
		}, () => "00000000-0000-0000-0000-000000000002")).toBe(42);
	});
});
