import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workingDirectory = process.cwd();
const repositoryRoot = fs.existsSync(path.resolve(workingDirectory, "apps/hono-api/package.json"))
	? workingDirectory
	: path.resolve(workingDirectory, "../..");

function read(relativePath: string): string {
	return fs.readFileSync(path.resolve(repositoryRoot, relativePath), "utf8");
}

function readScript(packageJson: string, scriptName: string): string {
	const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
	const script = parsed.scripts?.[scriptName];
	if (!script) throw new Error(`package script missing: ${scriptName}`);
	return script;
}

/**
 * 本地开发态的图片 worker 必须长期驻留，不能被源码监听器重建。
 *
 * 一次 ComfyUI 图片任务可持续 60~180 秒，远超 BullMQ 默认 lockDuration(30s)。
 * `node --watch` 重建子进程时不会投递 SIGTERM（本地实测 SIGTERM handler 从不执行），
 * worker 既无法 drain 也无法续锁，任务会被 stalled 检测判为
 * 「job stalled more than allowable limit」；由于图片 job 固定 maxStalledCount=0，
 * 首次 stall 即终态失败，而供应商可能已经出图，等于把已产出资产记成失败。
 */
describe("async image worker dev runtime", () => {
	it("does not run the long-lived dev worker under a source watcher", () => {
		const script = readScript(read("apps/hono-api/package.json"), "async-image:worker:dev");

		expect(script).not.toContain("--watch");
		expect(script).toContain("scripts/async-image-worker.ts");
	});

	it("keeps the dev stack on the source runtime instead of the built dist entrypoint", () => {
		const devScript = read("scripts/dev.mjs");

		expect(devScript).toContain("'async-image:worker:dev'");
		// dist 入口（无 :dev 后缀）只允许留在 docker-compose / pnpm start 的生产链路。
		expect(devScript).not.toContain("'async-image:worker',");
	});
});
