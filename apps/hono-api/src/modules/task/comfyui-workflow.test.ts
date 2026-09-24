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

	it("H3 全参考模式使用 media_state，不要求传统 LoadImage 节点与参考图数量相等", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "reference", h3Mode: "reference", h3InputMode: "reference", taskKind: "image_to_video", referenceImageCount: 0,
			workflow: {
				"3": { class_type: "MiniMaxH3Easy", inputs: { mode: "reference", prompt: "old" } },
				"42": { class_type: "MiniMaxH3EasyMediaLoader", inputs: { media_state: "{}" } },
			},
		}] } }, "minimax-h3").workflowVariants[0]!;
		const result = applyComfyUiWorkflowInputs(
			variant,
			{ kind: "image_to_video", prompt: "全参考", extras: {} },
			["ref-1.png", "ref-2.png"],
			1,
			[
				{ type: "image", role: "reference", url: "https://example.test/1.png", filename: "ref-1.png" },
				{ type: "image", role: "reference", url: "https://example.test/2.png", filename: "ref-2.png" },
			],
		);
		expect(JSON.parse(String(result["42"]?.inputs?.media_state))).toEqual({
			images: [{ filename: "ref-1.png" }, { filename: "ref-2.png" }], audios: [], videos: [],
		});
	});

	it("传统音频驱动工作流按显式节点绑定写入提示词、图片和音频", () => {
		const config = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "reference-audio-legacy",
			capability: "reference-audio-legacy",
			taskKind: "image_to_video",
			referenceImageCount: 0,
			promptInputBindings: [{ nodeId: "263", inputKey: "UNKNOWN" }],
			imageNodeIds: ["51"],
			audioLoaderNodeIds: ["48"],
			mediaInputNodeBinding: "legacy_loaders",
			workflow: {
				"48": { class_type: "LoadAudio", inputs: { audio: "source.mp3" } },
				"51": { class_type: "LoadImage", inputs: { image: "source.png" } },
				"263": { inputs: { UNKNOWN: "old prompt" } },
			},
		}] } }, "minimax-h3");
		const variant = selectComfyUiWorkflowVariant(config, {
			modelKey: "minimax-h3",
			taskKind: "image_to_video",
			capability: "reference-audio-legacy",
			mediaInputs: [
				{ type: "image", role: "reference", url: "https://example.test/actor.png" },
				{ type: "audio", role: "audio", url: "https://example.test/dialogue.mp3" },
			],
		});
		const result = applyComfyUiWorkflowInputs(variant, { kind: "image_to_video", prompt: "人物随音频自然说话", extras: {} }, [], 9, [
			{ type: "image", role: "reference", url: "https://example.test/actor.png", filename: "actor.png" },
			{ type: "audio", role: "audio", url: "https://example.test/dialogue.mp3", filename: "dialogue.mp3" },
		]);
		expect(result["263"]?.inputs?.UNKNOWN).toBe("人物随音频自然说话");
		expect(result["51"]?.inputs?.image).toBe("actor.png");
		expect(result["48"]?.inputs?.audio).toBe("dialogue.mp3");
	});

	it("传统音频驱动工作流对多个显式媒体节点保持顺序并拒绝数量不匹配", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "multi-reference-audio-legacy",
			taskKind: "image_to_video",
			referenceImageCount: 0,
			promptInputBindings: [{ nodeId: "263", inputKey: "UNKNOWN" }],
			imageNodeIds: ["51", "52"],
			audioLoaderNodeIds: ["48", "49"],
			mediaInputNodeBinding: "legacy_loaders",
			workflow: {
				"48": { class_type: "LoadAudio", inputs: { audio: "old-1.mp3" } },
				"49": { class_type: "LoadAudio", inputs: { audio: "old-2.mp3" } },
				"51": { class_type: "LoadImage", inputs: { image: "old-1.png" } },
				"52": { class_type: "LoadImage", inputs: { image: "old-2.png" } },
				"263": { inputs: { UNKNOWN: "old prompt" } },
			},
		}] } }, "minimax-h3").workflowVariants[0]!;
		const media = [
			{ type: "image" as const, role: "reference" as const, url: "https://example.test/1.png", filename: "1.png" },
			{ type: "audio" as const, role: "audio" as const, url: "https://example.test/1.mp3", filename: "1.mp3" },
			{ type: "image" as const, role: "reference" as const, url: "https://example.test/2.png", filename: "2.png" },
			{ type: "audio" as const, role: "audio" as const, url: "https://example.test/2.mp3", filename: "2.mp3" },
		];
		const result = applyComfyUiWorkflowInputs(variant, { kind: "image_to_video", prompt: "双人对话", extras: {} }, [], 9, media);
		expect(result["51"]?.inputs?.image).toBe("1.png");
		expect(result["52"]?.inputs?.image).toBe("2.png");
		expect(result["48"]?.inputs?.audio).toBe("1.mp3");
		expect(result["49"]?.inputs?.audio).toBe("2.mp3");
		expect(() => applyComfyUiWorkflowInputs(variant, { kind: "image_to_video", prompt: "缺少音频", extras: {} }, [], 9, media.slice(0, 3))).toThrow("音频加载节点数与输入不一致");
		expect(() => applyComfyUiWorkflowInputs(variant, { kind: "image_to_video", prompt: "缺少图片", extras: {} }, [], 9, [media[0]!, media[1]!, media[3]!])).toThrow("图片加载节点数与输入不一致");
	});

	it("H3 将分辨率规范化为 ComfyUI 大写枚举", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "text", h3Mode: "image", h3InputMode: "text", taskKind: "text_to_video", referenceImageCount: 0,
			workflow: { "3": { class_type: "MiniMaxH3Easy", inputs: { mode: "image", prompt: "old", resolution: "360P" } } },
		}] } }, "minimax-h3").workflowVariants[0]!;
		const result = applyComfyUiWorkflowInputs(variant, { kind: "text_to_video", prompt: "测试", extras: { resolution: "720p" } }, [], 1);
		expect(result["3"]?.inputs?.resolution).toBe("720P");
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
		expect(selectComfyUiWorkflowVariant(config, { modelKey: "klein9b", taskKind: "image_edit", referenceImageCount: 1 }).id).toBe("edit");
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

	it("动态参考图区间按请求数量匹配，并把每张图接到 autogrow 槽位", () => {
		const config = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageRange: { min: 1, max: 4 },
			referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
			referenceImageSlots: [
				{ nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 4 },
				{ nodeId: "505", inputKeyTemplate: "images.image{index}", startIndex: 0, maxSlots: 4 },
			],
			promptNodeIds: ["502"],
			outputNodeIds: ["494"],
			workflow: {
				"485": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "old", "images.image_1": ["470", 0] } },
				"505": { class_type: "BatchImagesNode", inputs: { "images.image0": ["470", 0] } },
				"502": { class_type: "TextGenerateLTX2Prompt", inputs: { prompt: "old" } },
				"494": { class_type: "SaveImageAdvanced", inputs: {} },
			},
		}] } }, "qwen-image-2.1");

		const twoImages = selectComfyUiWorkflowVariant(config, { modelKey: "qwen-image-2.1", taskKind: "image_edit", referenceImageCount: 2 });
		expect(twoImages.id).toBe("edit");
		const result = applyComfyUiWorkflowInputs(twoImages, { kind: "image_edit", prompt: "改成夜景", extras: {} }, ["ref-0.png", "ref-1.png"], 7);
		expect(result["485"]?.inputs?.["images.image_1"]).toEqual(["tapcanvas-ref-0", 0]);
		expect(result["485"]?.inputs?.["images.image_2"]).toEqual(["tapcanvas-ref-1", 0]);
		expect(result["505"]?.inputs?.["images.image0"]).toEqual(["tapcanvas-ref-0", 0]);
		expect(result["505"]?.inputs?.["images.image1"]).toEqual(["tapcanvas-ref-1", 0]);
		expect(result["tapcanvas-ref-0"]?.inputs?.image).toBe("ref-0.png");
		expect(result["tapcanvas-ref-1"]?.inputs?.image).toBe("ref-1.png");
		// 未被请求使用的槽位不应被凭空创建。
		expect(result["485"]?.inputs?.["images.image_3"]).toBeUndefined();
	});

	it("动态参考图数量超出声明区间时显式失败", () => {
		const config = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageRange: { min: 1, max: 3 },
			referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
			referenceImageSlots: [{ nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 3 }],
			workflow: { "485": { class_type: "TextEncodeQwenImage21", inputs: { "images.image_1": ["470", 0] } } },
		}] } }, "qwen-image-2.1");
		expect(() => selectComfyUiWorkflowVariant(config, { modelKey: "qwen-image-2.1", taskKind: "image_edit", referenceImageCount: 0 })).toThrow("无法唯一匹配");
		expect(() => selectComfyUiWorkflowVariant(config, { modelKey: "qwen-image-2.1", taskKind: "image_edit", referenceImageCount: 4 })).toThrow("无法唯一匹配");
	});

	it("动态参考图槽位与定数 imageNodeIds 不能混用", () => {
		expect(() => parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageRange: { min: 1, max: 2 },
			imageNodeIds: ["470"],
			referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
			referenceImageSlots: [{ nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 2 }],
			workflow: { "485": { class_type: "TextEncodeQwenImage21", inputs: { "images.image_1": ["470", 0] } } },
		}] } }, "qwen-image-2.1")).toThrow("不能同时声明");
	});

	it("动态参考图槽位容量不足以覆盖声明区间时显式失败", () => {
		expect(() => parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageRange: { min: 1, max: 5 },
			referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
			referenceImageSlots: [{ nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 3 }],
			workflow: { "485": { class_type: "TextEncodeQwenImage21", inputs: { "images.image_1": ["470", 0] } } },
		}] } }, "qwen-image-2.1")).toThrow("不足以覆盖");
	});

	it("动态参考图槽位残留 LoadImage 节点时显式失败", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageRange: { min: 1, max: 2 },
			referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
			referenceImageSlots: [{ nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 2 }],
			promptNodeIds: ["502"],
			workflow: {
				"470": { class_type: "LoadImage", inputs: { image: "leftover.png" } },
				"485": { class_type: "TextEncodeQwenImage21", inputs: { "images.image_1": ["470", 0] } },
				"502": { class_type: "TextGenerateLTX2Prompt", inputs: { prompt: "old" } },
			},
		}] } }, "qwen-image-2.1").workflowVariants[0]!;
		expect(() => applyComfyUiWorkflowInputs(variant, { kind: "image_edit", prompt: "改成夜景", extras: {} }, ["ref-0.png"], 1)).toThrow("残留");
	});

	it("referenceImageCount 与 referenceImageRange 必须且只能声明其一", () => {
		expect(() => parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			workflow,
		}] } }, "qwen-image-2.1")).toThrow("必须且只能声明");
		expect(() => parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageCount: 1,
			referenceImageRange: { min: 1, max: 2 },
			workflow,
		}] } }, "qwen-image-2.1")).toThrow("必须且只能声明");
	});

	it("参考图编码分辨率按工作流输出规模的等效边长换算并对齐 32", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageRange: { min: 1, max: 2 },
			referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
			referenceImageSlots: [{ nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 2 }],
			imageResolutionInputBindings: [{ nodeId: "485", inputKey: "resolution", alignTo: 32, min: 32, max: 4096, megapixelsFromNodeId: "13" }],
			promptNodeIds: ["502"],
			workflow: {
				"13": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "4:3 (Standard)", megapixels: 2, multiple: 8 } },
				"485": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "old", resolution: 1280, "images.image_1": ["470", 0] } },
				"502": { class_type: "TextGenerateLTX2Prompt", inputs: { prompt: "old" } },
			},
		}] } }, "qwen-image-2.1").workflowVariants[0]!;

		// megapixels=2 → 等效边长 1024*sqrt(2)=1448.2 → 对齐 32 得 1440。
		const result = applyComfyUiWorkflowInputs(
			variant,
			{ kind: "image_edit", prompt: "改成夜景", extras: { aspectRatio: "16:9" } },
			["ref-0.png"],
			1,
		);
		expect(result["485"]?.inputs?.resolution).toBe(1440);
		expect(Number(result["485"]?.inputs?.resolution) % 32).toBe(0);

		// 切换画幅比例不改变 megapixels，因此编码分辨率保持稳定。
		const portrait = applyComfyUiWorkflowInputs(
			variant,
			{ kind: "image_edit", prompt: "改成夜景", extras: { aspectRatio: "9:16" } },
			["ref-0.png"],
			1,
		);
		expect(portrait["485"]?.inputs?.resolution).toBe(1440);
	});

	it("工作流未声明输出规模且请求未携带像素尺寸时保留声明范围内的默认编码分辨率", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageRange: { min: 1, max: 2 },
			referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
			referenceImageSlots: [{ nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 2 }],
			imageResolutionInputBindings: [{ nodeId: "485", inputKey: "resolution", alignTo: 32, min: 32, max: 4096 }],
			promptNodeIds: ["502"],
			workflow: {
				"485": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "old", resolution: 1280, "images.image_1": ["470", 0] } },
				"502": { class_type: "TextGenerateLTX2Prompt", inputs: { prompt: "old" } },
			},
		}] } }, "qwen-image-2.1").workflowVariants[0]!;
		const result = applyComfyUiWorkflowInputs(variant, { kind: "image_edit", prompt: "改成夜景", extras: {} }, ["ref-0.png"], 1);
		expect(result["485"]?.inputs?.resolution).toBe(1280);
	});

	it("无法确定画布输出规模且工作流默认值超出声明范围时显式失败", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "edit",
			taskKind: "image_edit",
			referenceImageRange: { min: 1, max: 2 },
			referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
			referenceImageSlots: [{ nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 2 }],
			imageResolutionInputBindings: [{ nodeId: "485", inputKey: "resolution", alignTo: 32, min: 32, max: 1024 }],
			promptNodeIds: ["502"],
			workflow: {
				"485": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "old", resolution: 4096, "images.image_1": ["470", 0] } },
				"502": { class_type: "TextGenerateLTX2Prompt", inputs: { prompt: "old" } },
			},
		}] } }, "qwen-image-2.1").workflowVariants[0]!;
		expect(() => applyComfyUiWorkflowInputs(variant, { kind: "image_edit", prompt: "改成夜景", extras: {} }, ["ref-0.png"], 1)).toThrow("不在声明范围");
	});

	it("画幅绑定把请求比例写入尺寸控件枚举", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "text",
			taskKind: "text_to_image",
			referenceImageCount: 0,
			promptNodeIds: ["480"],
			outputNodeIds: ["479"],
			aspectRatioInputBindings: [{ nodeId: "13", inputKey: "aspect_ratio", valueMap: { "16:9": "16:9 (Widescreen)" } }],
			workflow: {
				"13": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "4:3 (Standard)", megapixels: 2, multiple: 8 } },
				"480": { class_type: "TextGenerateLTX2Prompt", inputs: { prompt: "old" } },
				"479": { class_type: "SaveImageAdvanced", inputs: {} },
			},
		}] } }, "qwen-image-2.1").workflowVariants[0]!;
		const result = applyComfyUiWorkflowInputs(variant, { kind: "text_to_image", prompt: "一只猫", extras: { aspectRatio: "16:9" } }, [], 7);
		expect(result["480"]?.inputs?.prompt).toBe("一只猫");
		expect(result["13"]?.inputs?.aspect_ratio).toBe("16:9 (Widescreen)");
	});

	it("画幅绑定未携带比例时保留已声明支持的默认值，映射外比例显式失败", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "text",
			taskKind: "text_to_image",
			referenceImageCount: 0,
			promptNodeIds: ["480"],
			aspectRatioInputBindings: [{ nodeId: "13", inputKey: "aspect_ratio", valueMap: { "16:9": "16:9 (Widescreen)", "4:3": "4:3 (Standard)" } }],
			workflow: {
				"13": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "4:3 (Standard)" } },
				"480": { class_type: "TextGenerateLTX2Prompt", inputs: { prompt: "old" } },
			},
		}] } }, "qwen-image-2.1").workflowVariants[0]!;
		const withoutAspect = applyComfyUiWorkflowInputs(variant, { kind: "text_to_image", prompt: "一只猫", extras: {} }, [], 7);
		expect(withoutAspect["13"]?.inputs?.aspect_ratio).toBe("4:3 (Standard)");
		expect(() => applyComfyUiWorkflowInputs(variant, { kind: "text_to_image", prompt: "一只猫", extras: { aspectRatio: "21:9" } }, [], 7)).toThrow("不支持画幅比例");
	});

	it("画幅绑定的工作流默认值不在支持列表内时显式失败", () => {
		const variant = parseComfyUiWorkflowConfig({ comfyui: { workflowVariants: [{
			id: "text",
			taskKind: "text_to_image",
			referenceImageCount: 0,
			promptNodeIds: ["480"],
			aspectRatioInputBindings: [{ nodeId: "13", inputKey: "aspect_ratio", valueMap: { "16:9": "16:9 (Widescreen)" } }],
			workflow: {
				"13": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "21:9 (Ultrawide)" } },
				"480": { class_type: "TextGenerateLTX2Prompt", inputs: { prompt: "old" } },
			},
		}] } }, "qwen-image-2.1").workflowVariants[0]!;
		expect(() => applyComfyUiWorkflowInputs(variant, { kind: "text_to_image", prompt: "一只猫", extras: {} }, [], 7)).toThrow("不在支持列表内");
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
