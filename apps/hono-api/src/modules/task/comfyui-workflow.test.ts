import { describe, expect, it } from "vitest";
import { parseComfyUiWorkflowConfig, selectComfyUiWorkflowVariant } from "./comfyui-workflow";

const workflow = {
	"1": { class_type: "CLIPTextEncode", inputs: { text: "old", clip: ["2", 0] } },
	"2": { class_type: "LoadImage", inputs: { image: "old.png" } },
	"3": { class_type: "SaveImage", inputs: { images: ["4", 0] } },
};

describe("ComfyUI 工作流目录", () => {
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
});
