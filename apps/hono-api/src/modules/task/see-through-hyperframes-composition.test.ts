import { describe, expect, it } from "vitest";

import { AppError } from "../../middleware/error";
import {
	buildSeeThroughHyperframesComposition,
	parseSeeThroughHyperframesInput,
} from "./see-through-hyperframes-composition";

function createInput(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		engine: "hyperframes",
		compositionId: "character-wave",
		sourceNodeId: "image-node-1",
		frameSize: [1280, 1280],
		durationSec: 4,
		backgroundColor: "#ffffff",
		parts: [
			{
				tag: "front hair",
				assetName: "see-through:front hair",
				xyxy: [100, 50, 400, 400],
				depthMedian: 0.1,
				url: "https://assets.example/front-hair.png",
			},
			{
				tag: "handwear-r",
				assetName: "see-through:handwear-r",
				xyxy: [600, 450, 860, 900],
				depthMedian: 0.9,
				url: "https://assets.example/handwear-r.png",
			},
		],
		motions: [{
			tag: "handwear-r",
			origin: [0.5, 0.1],
			keyframes: [
				{ second: 0, x: 0, y: 0, rotationDeg: 0 },
				{ second: 4, x: 8, y: -40, rotationDeg: 12 },
			],
		}],
		createdAt: "2026-09-11T06:00:00.000Z",
	};
}

describe("See-through HyperFrames 角色动画 composition", () => {
	it("按 HyperFrames 时间线合同生成部件动画并使用安全素材名", () => {
		const composition = buildSeeThroughHyperframesComposition(
			parseSeeThroughHyperframesInput(createInput()),
		);

		expect(composition.html).toContain('data-composition-id="character-wave"');
		expect(composition.html).toContain('data-width="1280"');
		expect(composition.html).toContain('data-duration="4"');
		expect(composition.html).toContain('class="clip character-part"');
		expect(composition.html).toContain('data-track-index="2"');
		expect(composition.html).toContain('data-track-index="1"');
		expect(composition.html).toContain('src="./assets/part-01.png"');
		expect(composition.html).toContain('src="./assets/part-02.png"');
		expect(composition.html).toContain('@keyframes motion-2');
		expect(composition.assets).toEqual([
			{ name: "part-01.png", url: "https://assets.example/front-hair.png" },
			{ name: "part-02.png", url: "https://assets.example/handwear-r.png" },
		]);
	});

	it("拒绝非 http(s) 部件资产", () => {
		const input = createInput();
		const parts = input.parts as Array<Record<string, unknown>>;
		parts[0] = { ...parts[0], url: "file:///private/front-hair.png" };
		expect(() => parseSeeThroughHyperframesInput(input)).toThrow(AppError);
	});

	it("拒绝引用不存在部件和不递增的关键帧", () => {
		const unknownPartInput = createInput();
		const unknownMotions = unknownPartInput.motions as Array<Record<string, unknown>>;
		unknownMotions[0] = { ...unknownMotions[0], tag: "missing-part" };
		expect(() => parseSeeThroughHyperframesInput(unknownPartInput)).toThrow(AppError);

		const timeInput = createInput();
		const motions = timeInput.motions as Array<Record<string, unknown>>;
		motions[0] = {
			...motions[0],
			keyframes: [
				{ second: 2, x: 0, y: 0, rotationDeg: 0 },
				{ second: 1, x: 8, y: -40, rotationDeg: 12 },
			],
		};
		expect(() => parseSeeThroughHyperframesInput(timeInput)).toThrow(AppError);
	});
});
