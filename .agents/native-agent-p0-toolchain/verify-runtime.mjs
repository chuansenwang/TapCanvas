import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const toolchainRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolchainRoot, "../..");
const tsc = resolve(toolchainRoot, "node_modules/typescript/bin/tsc");
const vitest = resolve(toolchainRoot, "node_modules/vitest/vitest.mjs");

function run(command, args, cwd = repositoryRoot) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

run(process.execPath, [tsc, "--noEmit", "-p", resolve(toolchainRoot, "tsconfig.runtime.json")]);
run(process.execPath, [tsc, "--noEmit", "-p", resolve(toolchainRoot, "tsconfig.host.json")]);
run(process.execPath, [vitest, "run", "--config", "vitest.config.ts"], resolve(repositoryRoot, "packages/agent-runtime"));
run(process.execPath, [vitest, "run", "--config", "vitest.config.ts"], resolve(repositoryRoot, "apps/agent-host"));
run(process.execPath, [resolve(repositoryRoot, "packages/agent-runtime/scripts/check-runtime-closure.mjs")]);

console.log(JSON.stringify({ outcome: "verified", typecheck: ["runtime", "host"], tests: ["runtime", "host"], closure: "passed", isolated: true }));
