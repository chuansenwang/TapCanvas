import { describe, expect, it } from "vitest";

import { AppError } from "../../middleware/error";
import {
	attachHostedCharacterDecompositionAssets,
	isSeeThroughCharacterDecompositionRequest,
	readSeeThroughParts,
} from "./see-through-character-decomposition";

describe("See-through 角色组件拆分合同", () => {
	it("解析语义部件、画幅和深度元数据", () => {
		const parsed = readSeeThroughParts({
			frame_size: [1080, 1920],
			parts: {
				"front hair": {
					tag: "front hair",
					xyxy: [120, 50, 960, 480],
					depth_median: 0.42,
					part_id: 7,
				},
			},
		});

		expect(parsed.frameSize).toEqual([1920, 1080]);
		expect(parsed.parts).toEqual([
			expect.objectContaining({
				tag: "front hair",
				assetName: "see-through:front hair",
				xyxy: [120, 50, 960, 480],
				depthMedian: 0.42,
				partId: 7,
			}),
		]);
	});

	it("拒绝只有部件索引的中间 LayerDiff 元数据", () => {
		expect(() => readSeeThroughParts({
			parts: { "front hair": {} },
		})).toThrow(AppError);
	});

	it("拒绝不安全的部件标签，避免输出路径穿越", () => {
		expect(() => readSeeThroughParts({
			frame_size: [10, 10],
			parts: { bad: { tag: "../bad", xyxy: [0, 0, 1, 1], depth_median: 0 } },
		})).toThrow(AppError);
	});

	it("托管后将元数据内的临时 data URL 回写为最终资产 URL", () => {
		const result = attachHostedCharacterDecompositionAssets({
			id: "see-through-task",
			kind: "image_edit",
			status: "succeeded",
			assets: [{
				type: "image",
				url: "http://127.0.0.1:8788/assets/local/front-hair.png",
				assetName: "see-through:front hair",
			}],
			raw: {
				characterDecomposition: {
					engine: "see-through",
					parts: [{
						tag: "front hair",
						assetName: "see-through:front hair",
						xyxy: [0, 0, 10, 10],
						depthMedian: 1,
						partId: 1,
						url: "data:image/png;base64,abc",
					}],
				},
			},
		});
		const raw = result.raw as { characterDecomposition: { parts: Array<{ url: string }> } };
		expect(raw.characterDecomposition.parts[0]?.url).toBe("http://127.0.0.1:8788/assets/local/front-hair.png");
	});

	it("只拦截明确声明的本机角色组件拆分请求", () => {
		expect(isSeeThroughCharacterDecompositionRequest({
			kind: "image_edit", prompt: "拆分", extras: { imageOperation: "character_decompose" },
		})).toBe(true);
		expect(isSeeThroughCharacterDecompositionRequest({
			kind: "image_edit", prompt: "拆分", extras: { imageOperation: "layer_decompose" },
		})).toBe(false);
	});
});
