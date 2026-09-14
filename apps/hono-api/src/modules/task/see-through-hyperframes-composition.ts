import {
	parseCharacterAnimationSpec,
	type CharacterAnimationMotion,
	type CharacterAnimationSpec,
} from "@tapcanvas/character-animation-protocol";

import { AppError } from "../../middleware/error";
import type { HyperframesRenderAsset } from "../apiKey/hyperframes-render";

export type SeeThroughHyperframesInput = CharacterAnimationSpec;

export type SeeThroughHyperframesComposition = Readonly<{
	html: string;
	assets: readonly HyperframesRenderAsset[];
}>;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function toSafeAssetName(index: number): string {
	return `part-${String(index + 1).padStart(2, "0")}.png`;
}

function createMotionCss(input: {
	motion: CharacterAnimationMotion;
	durationSec: number;
	animationName: string;
}): string {
	const { motion, durationSec, animationName } = input;
	const frames = motion.keyframes.map((frame) => {
		const percent = Math.min(100, Math.max(0, (frame.second / durationSec) * 100));
		const scaleX = frame.scaleX ?? 1;
		const scaleY = frame.scaleY ?? 1;
		const opacity = frame.opacity ?? 1;
		return `${percent.toFixed(4)}% { transform: translate(${frame.x}px, ${frame.y}px) rotate(${frame.rotationDeg}deg) scale(${scaleX}, ${scaleY}); opacity: ${opacity}; }`;
	});
	return `@keyframes ${animationName} { ${frames.join(" ")} }`;
}

export function parseSeeThroughHyperframesInput(value: unknown): SeeThroughHyperframesInput {
	try {
		return parseCharacterAnimationSpec(value);
	} catch (error: unknown) {
		throw new AppError(error instanceof Error ? error.message : "HyperFrames 角色动画合同无效", {
			status: 400,
			code: "hyperframes_character_animation_invalid",
		});
	}
}

/**
 * 将 See-through 给出的绝对裁切坐标和深度序重建成 HyperFrames composition。
 * 这里不放原始底图，避免透明部件与底图中的肢体、头发发生重影。
 */
export function buildSeeThroughHyperframesComposition(
	input: SeeThroughHyperframesInput,
): SeeThroughHyperframesComposition {
	const parts = input.parts
		.map((part, index) => ({
			part,
			asset: { name: toSafeAssetName(index), url: part.url },
		}))
		// See-through PSD 保存时按 depth 降序绘制；此处以相反顺序和递减 z-index 重建。
		.sort((left, right) => left.part.depthMedian - right.part.depthMedian);
	const motionByTag = new Map(input.motions.map((motion) => [motion.tag, motion]));
	const animationCss: string[] = [];
	const images = parts
		.map(({ part, asset }, index) => {
			const motion = motionByTag.get(part.tag);
			const animationName = `motion-${index + 1}`;
			if (motion) {
				animationCss.push(createMotionCss({ motion, durationSec: input.durationSec, animationName }));
			}
			const [left, top, right, bottom] = part.xyxy;
			const style = [
				"position:absolute",
				`left:${left}px`,
				`top:${top}px`,
				`width:${right - left}px`,
				`height:${bottom - top}px`,
				`z-index:${parts.length - index}`,
				"pointer-events:none",
				motion ? `transform-origin:${motion.origin[0] * 100}% ${motion.origin[1] * 100}%` : "",
				motion ? `animation:${animationName} ${input.durationSec}s linear both` : "",
			].filter(Boolean).join(";");
			return `<img class="clip character-part" data-start="0" data-duration="${input.durationSec}" data-track-index="${parts.length - index}" alt="${escapeHtml(part.tag)}" src="./assets/${asset.name}" style="${style}" />`;
		})
		.join("\n");
	const css = `*{box-sizing:border-box}html,body{margin:0;width:${input.frameSize[0]}px;height:${input.frameSize[1]}px;overflow:hidden;background:${input.backgroundColor}}#root{position:relative;width:${input.frameSize[0]}px;height:${input.frameSize[1]}px;overflow:hidden;background:${input.backgroundColor}}.character-part{object-fit:fill;will-change:transform,opacity}${animationCss.join("\n")}`;
	const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=${input.frameSize[0]}, height=${input.frameSize[1]}" /><style>${css}</style></head><body><div id="root" data-composition-id="${escapeHtml(input.compositionId)}" data-start="0" data-duration="${input.durationSec}" data-width="${input.frameSize[0]}" data-height="${input.frameSize[1]}">${images}</div></body></html>`;
	return { html, assets: parts.map(({ asset }) => asset) };
}
