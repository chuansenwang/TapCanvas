/**
 * ComfyUI 显存回收。
 *
 * 背景：ComfyUI 默认把加载过的模型权重留在显存里复用（"smart memory"）。MiniMax H3 音频在本机
 * 16G 显卡上执行完后会常驻约 13~14GB，占满整卡——执行结束并不意味着显存被归还给系统，
 * 其它任务（含 ComfyUI 自己的其它工作流）会拿不到显存。
 *
 * `/free` 是 ComfyUI 官方接口，且只给任务队列置标志、在队列空闲时才真正卸载模型，
 * 不会打断正在执行或排队中的任务，因此可以安全地在每次生成本地 H3 之后调用。
 *
 * 代价：回收后下一次生成需要重新加载模型（约 1~2 分钟）。因此由
 * `MINIMAX_H3_FREE_VRAM_AFTER_RUN` 显式控制，默认开启；需要连续批量生成、愿意用显存换速度时
 * 设为 `0`/`false` 关闭。
 */

import { AppError } from "../../middleware/error";

/** 读取 env（含 process.env 兜底），与 rustfs.client 的口径一致。 */
function readEnvString(env: unknown, key: string): string {
	const fromEnv =
		env && typeof env === "object" && typeof (env as Record<string, unknown>)[key] === "string"
			? String((env as Record<string, unknown>)[key]).trim()
			: "";
	if (fromEnv) return fromEnv;
	const processRef = globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	};
	const fromProcess = processRef.process?.env?.[key];
	return typeof fromProcess === "string" ? fromProcess.trim() : "";
}

/**
 * 是否在本地 H3 生成结束后回收 ComfyUI 显存。
 * 未设置时默认开启（H3 常驻显存会占满整卡的代价高于一次模型重载）。
 */
export function shouldFreeComfyVramAfterRun(env: unknown): boolean {
	const raw = readEnvString(env, "MINIMAX_H3_FREE_VRAM_AFTER_RUN").toLowerCase();
	if (!raw) return true;
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveFreeEndpoint(baseUrl: string): string {
	return new URL("free", `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

/** 调用 ComfyUI `/free` 卸载模型并释放显存；失败时显式抛错。 */
export async function releaseComfyVram(baseUrl: string): Promise<void> {
	const endpoint = resolveFreeEndpoint(baseUrl);
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ unload_models: true, free_memory: true }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new AppError(`ComfyUI 显存回收连接失败：${cause}`, {
			status: 502,
			code: "comfyui_free_request_failed",
			details: { endpoint, cause },
		});
	}
	if (!response.ok) {
		throw new AppError(`ComfyUI 显存回收失败：${response.status}`, {
			status: 502,
			code: "comfyui_free_request_failed",
			details: { endpoint, status: response.status },
		});
	}
}

/**
 * 按配置回收显存。这是生成主流程之后的清理步骤：失败不覆盖主流程的产物或原始错误，
 * 但必须留下可检索日志，不静默跳过。
 */
export async function releaseComfyVramAfterRun(env: unknown, baseUrl: string): Promise<boolean> {
	if (!shouldFreeComfyVramAfterRun(env)) return false;
	try {
		await releaseComfyVram(baseUrl);
		return true;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error("[minimax-h3] ComfyUI 显存回收失败，模型可能仍常驻显存", {
			baseUrl,
			reason,
		});
		return false;
	}
}
