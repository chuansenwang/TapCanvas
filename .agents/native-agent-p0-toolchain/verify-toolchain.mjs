import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function version(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

const nodeVersion = process.versions.node;
const major = Number(nodeVersion.split(".")[0]);
if (!Number.isSafeInteger(major) || major < 24) throw new Error(`Native Agent P0 requires Node 24+, found ${nodeVersion}`);
const packageMetadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const requiredPnpmVersion = String(packageMetadata.packageManager ?? "").replace(/^pnpm@/, "");
if (requiredPnpmVersion !== "11.0.0") throw new Error(`Native Agent P0 requires a pnpm@11.0.0 toolchain pin, found ${requiredPnpmVersion || "missing"}`);
const userAgentVersion = process.env.npm_config_user_agent?.match(/(?:^|\s)pnpm\/(\d+\.\d+\.\d+)/)?.[1];
const pnpmVersion = userAgentVersion ?? version("pnpm", ["--version"]);
if (pnpmVersion !== requiredPnpmVersion) throw new Error(`Native Agent P0 requires the active pnpm executable to be ${requiredPnpmVersion}, found ${pnpmVersion}`);
const tscVersion = version(process.execPath, [fileURLToPath(new URL("./node_modules/typescript/bin/tsc", import.meta.url)), "--version"]);
if (!tscVersion.startsWith("Version 6.")) throw new Error(`Native Agent P0 requires TypeScript 6, found ${tscVersion}`);
console.log(JSON.stringify({ node: nodeVersion, pnpm: pnpmVersion, typescript: tscVersion, isolated: true }));
