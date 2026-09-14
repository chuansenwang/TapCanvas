import { describe, expect, it } from "vitest";
import {
	ModelCatalogModelSchema,
	UpsertModelCatalogModelSchema,
} from "./model-catalog.schemas";

describe("模型目录音频模型契约", () => {
	it("接受声明音频能力的已配置模型", () => {
		const input = {
			modelKey: "indextts-2.5",
			vendorKey: "comfyui",
			labelZh: "IndexTTS 2.5",
			kind: "audio",
			enabled: true,
			meta: {
				tags: [
					"tapcanvas:audio-type=speech",
					"tapcanvas:audio-engine=comfyui",
				],
			},
		};

		expect(UpsertModelCatalogModelSchema.parse(input).kind).toBe("audio");
		expect(ModelCatalogModelSchema.parse({
			...input,
			createdAt: "2026-09-13T00:00:00.000Z",
			updatedAt: "2026-09-13T00:00:00.000Z",
		}).kind).toBe("audio");
	});
});
