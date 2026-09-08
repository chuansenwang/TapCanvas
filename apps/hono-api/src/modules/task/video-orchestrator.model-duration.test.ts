import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../types";
import { listModelCatalogModels } from "../model-catalog/model-catalog.service";
import { resolveModelDurationOptions } from "./video-orchestrator.model-duration";

vi.mock("../model-catalog/model-catalog.service", () => ({
	listModelCatalogModels: vi.fn(),
}));

const createContext = (): AppContext =>
	({ env: { DB: {} } }) as unknown as AppContext;

beforeEach(() => {
	vi.mocked(listModelCatalogModels).mockResolvedValue([
		{
			modelKey: "minimax-h3",
			modelAlias: "minimax-h3",
			labelZh: "MiniMax H3",
			vendorKey: "comfyui",
			kind: "video",
			enabled: true,
			meta: {
				videoOptions: {
					defaultDurationSeconds: 4,
					durationOptions: Array.from({ length: 15 }, (_, index) => index + 1),
				},
			},
		},
	]);
});

describe("resolveModelDurationOptions", () => {
	it("从实时目录读取 H3 的完整 1–15 秒档位", async () => {
		const options = await resolveModelDurationOptions({
			c: createContext(),
			modelKey: "minimax-h3",
		});

		expect(options).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
		expect(options).toContain(1);
		expect(options).toContain(15);
	});

	it("不把默认 4 秒误当成唯一档位", async () => {
		const options = await resolveModelDurationOptions({
			c: createContext(),
			modelKey: "minimax-h3",
		});

		expect(options).not.toEqual([4]);
	});
});
