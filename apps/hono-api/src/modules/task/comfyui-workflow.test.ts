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

	it("H3 按任务和媒体角色选择文生、首尾帧、多图参考模式", () => {
		const baseWorkflow = {
			"3": { class_type: "MiniMaxH3Easy", inputs: { mode: "reference", prompt: "old", keyframe_role: "first" } },
			"42": { class_type: "MiniMaxH3EasyMediaLoader", inputs: { media_state: "{}" } },
			"21": { class_type: "SaveVideo", inputs: {} },
		};
		const config = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [
			{ id: "text", h3Mode: "image", h3InputMode: "text", taskKind: "text_to_video", referenceImageCount: 0, workflow: baseWorkflow },
			{ id: "first-frame", h3Mode: "image", h3InputMode: "first_frame", taskKind: "image_to_video", referenceImageCount: 0, workflow: baseWorkflow },
			{ id: "keyframes", h3Mode: "image", h3InputMode: "first_last_frame", taskKind: "image_to_video", referenceImageCount: 0, workflow: baseWorkflow },
			{ id: "reference", h3Mode: "reference", h3InputMode: "reference", taskKind: "image_to_video", referenceImageCount: 0, workflow: baseWorkflow },
		] } }, "minimax-h3");
		const first = { type: "image" as const, role: "first_frame" as const, url: "https://example.test/first.png" };
		const last = { type: "image" as const, role: "last_frame" as const, url: "https://example.test/last.png" };
		const reference = { type: "image" as const, role: "reference" as const, url: "https://example.test/ref.png" };
		expect(selectComfyUiWorkflowVariant(config, { modelKey: "minimax-h3", taskKind: "text_to_video", referenceImageCount: 0 }).id).toBe("text");
		expect(selectComfyUiWorkflowVariant(config, { modelKey: "minimax-h3", taskKind: "text_to_video", referenceImageCount: 1, mediaInputs: [first] }).id).toBe("first-frame");
		expect(selectComfyUiWorkflowVariant(config, { modelKey: "minimax-h3", taskKind: "image_to_video", referenceImageCount: 0, mediaInputs: [first, last] }).id).toBe("keyframes");
		expect(selectComfyUiWorkflowVariant(config, { modelKey: "minimax-h3", taskKind: "image_to_video", referenceImageCount: 0, mediaInputs: [reference] }).id).toBe("reference");
		const keyframeVariant = config.workflowVariants.find((variant) => variant.id === "keyframes")!;
		const patched = applyComfyUiWorkflowInputs(keyframeVariant, { kind: "image_to_video", prompt: "首尾帧", extras: {} }, [], 1, [
			{ ...first, filename: "first.png" }, { ...last, filename: "last.png" },
		]);
		expect(patched["3"]?.inputs?.mode).toBe("image");
		expect(patched["3"]?.inputs?.keyframe_role).toBe("first");
	});

	it("H3 文生视频没有媒体时使用 text 合同", () => {
		const h3Variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{ id: "h3", h3Mode: "image", h3InputMode: "text", taskKind: "text_to_video", referenceImageCount: 0, workflow: { "3": { class_type: "MiniMaxH3Easy", inputs: { mode: "reference", prompt: "old" } }, "42": { class_type: "MiniMaxH3EasyMediaLoader", inputs: { media_state: "{}" } } } }] } }, "minimax-h3").workflowVariants[0]!;
		const result = applyComfyUiWorkflowInputs(h3Variant, { kind: "text_to_video", prompt: "生成视频", extras: {} }, [], 1);
		expect(result["3"]?.inputs?.mode).toBe("image");
		expect(JSON.parse(String(result["42"]?.inputs?.media_state))).toEqual({ images: [], audios: [], videos: [] });
	});

	it("H3 区分尾帧、全参考和显式数字人合同", () => {
		const makeVariant = (id: string, h3Mode: "image" | "reference" | "digital_human", h3InputMode: "last_frame" | "reference" | "digital_human") => parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{ id, h3Mode, h3InputMode, taskKind: "image_to_video", referenceImageCount: 0, workflow: {
			"3": { class_type: "MiniMaxH3Easy", inputs: { mode: "image", prompt: "old", keyframe_role: "first" } },
			"42": { class_type: "MiniMaxH3EasyMediaLoader", inputs: { media_state: "{}" } },
		} }] } }, "minimax-h3").workflowVariants[0]!;
		const last = { type: "image" as const, role: "last_frame" as const, url: "https://example.test/last.png", filename: "last.png" };
		const lastVariant = makeVariant("last", "image", "last_frame");
		expect(selectComfyUiWorkflowVariant({ workflowVariants: [lastVariant] }, { modelKey: "minimax-h3", taskKind: "image_to_video", mediaInputs: [last] }).id).toBe("last");
		expect(applyComfyUiWorkflowInputs(lastVariant, { kind: "image_to_video", prompt: "尾帧", extras: {} }, [], 1, [last])["3"]?.inputs?.keyframe_role).toBe("last");

		const referenceVariant = makeVariant("reference", "reference", "reference");
		const reference = { type: "video" as const, role: "video" as const, url: "https://example.test/ref.mp4", filename: "ref.mp4" };
		expect(selectComfyUiWorkflowVariant({ workflowVariants: [referenceVariant] }, { modelKey: "minimax-h3", taskKind: "image_to_video", mediaInputs: [reference] }).id).toBe("reference");
		expect(() => selectComfyUiWorkflowVariant({ workflowVariants: [referenceVariant] }, { modelKey: "minimax-h3", taskKind: "image_to_video", mediaInputs: [{ ...last, role: "last_frame" }], h3InputMode: "reference" })).toThrow("不能携带首帧或尾帧");

		const digitalVariant = makeVariant("digital", "digital_human", "digital_human");
		const portrait = { type: "image" as const, role: "reference" as const, url: "https://example.test/person.png", filename: "person.png" };
		const audio = { type: "audio" as const, role: "audio" as const, url: "https://example.test/drive.wav", filename: "drive.wav" };
		expect(selectComfyUiWorkflowVariant({ workflowVariants: [digitalVariant] }, { modelKey: "minimax-h3", taskKind: "image_to_video", mediaInputs: [portrait, audio], h3InputMode: "digital_human" }).id).toBe("digital");
		expect(() => selectComfyUiWorkflowVariant({ workflowVariants: [digitalVariant] }, { modelKey: "minimax-h3", taskKind: "image_to_video", mediaInputs: [portrait], h3InputMode: "digital_human" })).toThrow("需要至少一张人物图片和一段驱动音频");
	});
	it("IndexTTS 三种模式分别绑定音色参考和情绪控制", () => {
		const makeVariant = (mode: "basic" | "vector" | "text") => parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{ id: mode, capability: `emotion-${mode}`, taskKind: "text_to_audio", referenceImageCount: 0, audioLoaderNodeIds: ["4"], ...(mode !== "basic" ? { emotionControlNodeIds: ["5"], audioEmotionMode: mode } : {}), workflow: {
				"2": { class_type: "XZG_IndexTTS25_Generate", inputs: { text: "old", speaker_audio: ["4", 0], ...(mode !== "basic" ? { emotion: ["5", 0] } : {}) } },
				"4": { class_type: "XiaozhuguangAudioLoader", inputs: { "音频": "old.wav" } },
				"5": { class_type: "XZG_IndexTTS25_EmotionControl", inputs: { mode: mode, "mode.happy": 0, "mode.angry": 0, "mode.sad": 0, "mode.afraid": 0, "mode.disgusted": 0, "mode.melancholic": 0, "mode.surprised": 0, "mode.calm": 0, "mode.emotion_text": "" } },
			} }] } }, "indextts").workflowVariants[0]!;
		const media = [{ type: "audio" as const, role: "reference" as const, url: "https://example.test/ref.wav", filename: "ref.wav" }];
		const basic = applyComfyUiWorkflowInputs(makeVariant("basic"), { kind: "text_to_audio", prompt: "你好", extras: {} }, [], 1, media);
		expect(basic["2"]?.inputs?.text).toBe("你好");
		expect(basic["4"]?.inputs?.["音频"]).toBe("ref.wav");
		const vector = applyComfyUiWorkflowInputs(makeVariant("vector"), { kind: "text_to_audio", prompt: "你好", extras: { emotionVector: [1, 0, 0, 0, 0, 0, 0, 0] } }, [], 1, media);
		expect(vector["5"]?.inputs?.["mode.happy"]).toBe(1);
		const text = applyComfyUiWorkflowInputs(makeVariant("text"), { kind: "text_to_audio", prompt: "你好", extras: { emotionText: "克制而紧张" } }, [], 1, media);
		expect(text["5"]?.inputs?.["mode.emotion_text"]).toBe("克制而紧张");
	});

	it("IndexTTS 情绪输入缺失时显式失败", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{ id: "vector", taskKind: "text_to_audio", referenceImageCount: 0, audioLoaderNodeIds: ["4"], emotionControlNodeIds: ["5"], audioEmotionMode: "vector", workflow: { "2": { class_type: "XZG_IndexTTS25_Generate", inputs: { text: "old" } }, "4": { class_type: "XiaozhuguangAudioLoader", inputs: { "音频": "old.wav" } }, "5": { class_type: "XZG_IndexTTS25_EmotionControl", inputs: { mode: "vector" } } } }] } }, "indextts").workflowVariants[0]!;
		expect(() => applyComfyUiWorkflowInputs(variant, { kind: "text_to_audio", prompt: "你好", extras: {} }, [], 1, [{ type: "audio", role: "reference", url: "https://example.test/ref.wav", filename: "ref.wav" }])).toThrow("情绪向量");
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
