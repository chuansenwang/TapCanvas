import { AppError } from "../../middleware/error";
import type { AppContext } from "../../types";
import { renderHyperframesComposition } from "../apiKey/hyperframes-render";
import { buildSeeThroughHyperframesComposition, parseSeeThroughHyperframesInput } from "./see-through-hyperframes-composition";
import { TaskResultSchema, type TaskRequestDto, type TaskResultDto } from "./task.schemas";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new AppError(`HyperFrames 角色动画缺少 ${field}`, {
			status: 400,
			code: "hyperframes_character_animation_input_missing",
		});
	}
	return value;
}

export function isSeeThroughHyperframesAnimationRequest(req: TaskRequestDto): boolean {
	return req.kind === "image_edit" && req.extras?.imageOperation === "character_animate_hyperframes";
}

export async function runSeeThroughHyperframesCharacterAnimation(
	c: AppContext,
	userId: string,
	req: TaskRequestDto,
): Promise<TaskResultDto> {
	const extras = readRecord(req.extras, "extras");
	const animation = parseSeeThroughHyperframesInput(
		readRecord(extras.characterAnimation, "extras.characterAnimation"),
	);
	const composition = buildSeeThroughHyperframesComposition(animation);
	const rendered = await renderHyperframesComposition(c, userId, {
		html: composition.html,
		assets: [...composition.assets],
		fps: typeof extras.fps === "number" ? extras.fps : 24,
		quality: "standard",
	});
	return TaskResultSchema.parse({
		id: `hyperframes-character-${crypto.randomUUID()}`,
		kind: "image_edit",
		status: "succeeded",
		assets: [{
			type: "video",
			url: rendered.url,
			assetName: `hyperframes:${animation.compositionId}`,
			fileName: `${animation.compositionId}.mp4`,
			mimeType: "video/mp4",
		}],
		raw: {
			provider: "hyperframes",
			characterAnimation: {
				engine: "hyperframes",
				compositionId: animation.compositionId,
				frameSize: animation.frameSize,
				durationSec: rendered.durationSec ?? animation.durationSec,
				partCount: animation.parts.length,
				motionCount: animation.motions.length,
			},
		},
	});
}
