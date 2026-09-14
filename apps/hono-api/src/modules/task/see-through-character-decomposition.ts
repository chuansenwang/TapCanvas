import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { AppError } from "../../middleware/error";
import { fetchWithHttpDebugLog } from "../../httpDebugLog";
import type { AppContext } from "../../types";
import { createTaskWorkspace } from "../../platform/node/task-workspace";
import { TaskResultSchema, type TaskAssetDto, type TaskRequestDto, type TaskResultDto } from "./task.schemas";

const execFileAsync = promisify(execFile);
const SEE_THROUGH_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_SOURCE_IMAGE_BYTES = 24 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type SeeThroughCharacterPart = Readonly<{
  tag: string;
  assetName: string;
  xyxy: readonly [number, number, number, number];
  depthMedian: number;
  partId: number | null;
  url: string;
}>;

type SeeThroughConfig = Readonly<{
  rootDirectory: string;
  pythonPath: string;
  entryPath: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("See-through 输出缺少 " + field, { status: 502, code: "see_through_output_invalid" });
  }
  return value.trim();
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("See-through 输出字段无效：" + field, { status: 502, code: "see_through_output_invalid" });
  }
  return value;
}

function readFrameSize(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new AppError("See-through 输出缺少 frame_size", { status: 502, code: "see_through_output_invalid" });
  }
  const height = Math.trunc(requireNumber(value[0], "frame_size[0]"));
  const width = Math.trunc(requireNumber(value[1], "frame_size[1]"));
  if (width < 1 || height < 1) {
    throw new AppError("See-through 输出 frame_size 无效", { status: 502, code: "see_through_output_invalid" });
  }
  return [width, height];
}

function readXyxy(value: unknown, tag: string): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new AppError("See-through 部件缺少 xyxy：" + tag, { status: 502, code: "see_through_output_invalid" });
  }
  const left = Math.trunc(requireNumber(value[0], tag + ".xyxy[0]"));
  const top = Math.trunc(requireNumber(value[1], tag + ".xyxy[1]"));
  const right = Math.trunc(requireNumber(value[2], tag + ".xyxy[2]"));
  const bottom = Math.trunc(requireNumber(value[3], tag + ".xyxy[3]"));
  if (right <= left || bottom <= top) {
    throw new AppError("See-through 部件 xyxy 无效：" + tag, { status: 502, code: "see_through_output_invalid" });
  }
  return [left, top, right, bottom];
}

function partFileName(tag: string): string {
  if (tag.includes("/") || tag.includes("\\") || tag.includes("..")) {
    throw new AppError("See-through 部件标签不安全：" + tag, { status: 502, code: "see_through_output_invalid" });
  }
  return tag + ".png";
}

function resolveConfig(): SeeThroughConfig {
  const rootDirectory = (process.env.SEE_THROUGH_ROOT || "").trim();
  if (!rootDirectory) {
    throw new AppError("角色组件拆分未配置：请设置 SEE_THROUGH_ROOT 为本机 See-through 仓库绝对路径", {
      status: 503,
      code: "see_through_unconfigured",
    });
  }
  if (!path.isAbsolute(rootDirectory)) {
    throw new AppError("SEE_THROUGH_ROOT 必须是绝对路径", { status: 500, code: "see_through_config_invalid" });
  }
  return {
    rootDirectory,
    pythonPath: (process.env.SEE_THROUGH_PYTHON || path.join(rootDirectory, ".venv", "Scripts", "python.exe")).trim(),
    entryPath: path.join(rootDirectory, "inference", "scripts", "inference_psd.py"),
  };
}

async function requireInstallation(config: SeeThroughConfig): Promise<void> {
  const checks = await Promise.all([config.rootDirectory, config.pythonPath, config.entryPath].map(async (candidate) => {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  }));
  if (checks.every(Boolean)) return;
  throw new AppError("角色组件拆分不可用：See-through 仓库、Python 环境或推理脚本不存在", {
    status: 503,
    code: "see_through_installation_missing",
    details: config,
  });
}

function sourceUrlFromRequest(req: TaskRequestDto): string {
  const values = Array.isArray(req.extras?.referenceImages) ? req.extras.referenceImages : [];
  const source = values.find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (!source) {
    throw new AppError("角色组件拆分缺少源图片（extras.referenceImages）", { status: 400, code: "see_through_source_missing" });
  }
  return source.trim();
}

async function downloadSource(c: AppContext, sourceUrl: string): Promise<{ bytes: Uint8Array; extension: string }> {
  const resolved = sourceUrl.startsWith("/") ? new URL(sourceUrl, new URL(c.req.url).origin).toString() : sourceUrl;
  if (!/^https?:\/\//i.test(resolved)) {
    throw new AppError("角色组件拆分只接受可访问的 http(s) 图片 URL", { status: 400, code: "see_through_source_invalid" });
  }
  const response = await fetchWithHttpDebugLog(
    c,
    resolved,
    { headers: { Accept: "image/*,*/*;q=0.8" } },
    { tag: "see-through source image" },
  );
  if (!response.ok) {
    throw new AppError("角色组件拆分下载源图失败：" + response.status, { status: 502, code: "see_through_source_fetch_failed" });
  }
  const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new AppError("角色组件拆分源文件不是图片", { status: 400, code: "see_through_source_invalid_mime" });
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_SOURCE_IMAGE_BYTES) {
    throw new AppError("角色组件拆分源图超过 24MB", { status: 400, code: "see_through_source_too_large" });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    throw new AppError("角色组件拆分源图为空或超过 24MB", { status: 400, code: "see_through_source_too_large" });
  }
  return { bytes, extension: mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png" };
}

export function isSeeThroughCharacterDecompositionRequest(req: TaskRequestDto): boolean {
  return req.kind === "image_edit" && req.extras?.imageOperation === "character_decompose";
}

export function readSeeThroughParts(info: unknown): Readonly<{ frameSize: readonly [number, number]; parts: readonly Omit<SeeThroughCharacterPart, "url">[] }> {
  if (!isRecord(info) || !isRecord(info.parts)) {
    throw new AppError("See-through 输出缺少语义部件元数据", { status: 502, code: "see_through_output_invalid" });
  }
  const parts = Object.entries(info.parts).map(([key, raw]) => {
    if (!isRecord(raw)) {
      throw new AppError("See-through 部件无效：" + key, { status: 502, code: "see_through_output_invalid" });
    }
    const tag = requireString(raw.tag ?? key, key + ".tag");
    partFileName(tag);
    return {
      tag,
      assetName: "see-through:" + tag,
      xyxy: readXyxy(raw.xyxy, tag),
      depthMedian: requireNumber(raw.depth_median, tag + ".depth_median"),
      partId: typeof raw.part_id === "number" && Number.isInteger(raw.part_id) ? raw.part_id : null,
    };
  });
  if (parts.length === 0) {
    throw new AppError("See-through 没有产出任何语义角色部件", { status: 502, code: "see_through_output_empty" });
  }
  return { frameSize: readFrameSize(info.frame_size), parts };
}

export async function runSeeThroughCharacterDecomposition(c: AppContext, req: TaskRequestDto): Promise<TaskResultDto> {
  const config = resolveConfig();
  await requireInstallation(config);
  const sourceUrl = sourceUrlFromRequest(req);
  const source = await downloadSource(c, sourceUrl);
  const workspace = await createTaskWorkspace("see-through");
  const startedAt = Date.now();
  try {
    const inputPath = path.join(workspace.path, "source." + source.extension);
    const outputRoot = path.join(workspace.path, "output");
    await fs.writeFile(inputPath, source.bytes, { flag: "wx" });
    await fs.mkdir(outputRoot, { recursive: true });
    const outcome = await execFileAsync(config.pythonPath, [
      config.entryPath, "--srcp", inputPath, "--save_dir", outputRoot, "--tblr_split", "--disable_progressbar",
    ], { cwd: config.rootDirectory, timeout: SEE_THROUGH_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
    // inference_psd 先写出 LayerDiff 的中间目录，再由 further_extr 写入
    // 语义部件、坐标和深度齐全的 optimized 子目录。中间 info.json 只有标签索引，
    // 不能用于 HyperFrames 的空间编排。
    const outputDirectory = path.join(outputRoot, "source", "optimized");
    let info: unknown;
    try {
      info = JSON.parse(await fs.readFile(path.join(outputDirectory, "info.json"), "utf8")) as unknown;
    } catch (error: unknown) {
      throw new AppError("See-through 未生成可读取的 info.json", {
        status: 502,
        code: "see_through_output_missing",
        details: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    const parsed = readSeeThroughParts(info);
    const parts: SeeThroughCharacterPart[] = [];
    const assets: TaskAssetDto[] = [];
    for (const part of parsed.parts) {
      const bytes = await fs.readFile(path.join(outputDirectory, partFileName(part.tag)));
      if (bytes.byteLength === 0) {
        throw new AppError("See-through 部件为空：" + part.tag, { status: 502, code: "see_through_output_invalid" });
      }
      const url = "data:image/png;base64," + bytes.toString("base64");
      parts.push({ ...part, url });
      assets.push({ type: "image", url, assetName: part.assetName, fileName: partFileName(part.tag), mimeType: "image/png" });
    }
    return TaskResultSchema.parse({
      id: "see-through-" + crypto.randomUUID(),
      kind: "image_edit",
      status: "succeeded",
      assets,
      raw: {
        provider: "see-through",
        durationMs: Date.now() - startedAt,
        diagnostics: { stdout: String(outcome.stdout).slice(-4000), stderr: String(outcome.stderr).slice(-4000) },
        characterDecomposition: { engine: "see-through", sourceUrl, frameSize: parsed.frameSize, parts },
      },
    });
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    throw new AppError("See-through 角色组件拆分失败", {
      status: 502,
      code: "see_through_execution_failed",
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    await workspace.cleanup();
  }
}

export function attachHostedCharacterDecompositionAssets(result: TaskResultDto): TaskResultDto {
  if (!isRecord(result.raw) || !isRecord(result.raw.characterDecomposition) || !Array.isArray(result.raw.characterDecomposition.parts)) return result;
  const assetsByName = new Map(result.assets.map((asset) => [asset.assetName || "", asset]));
  const parts = result.raw.characterDecomposition.parts.map((raw): SeeThroughCharacterPart => {
    if (!isRecord(raw)) throw new Error("角色部件资产元数据无效");
    const assetName = requireString(raw.assetName, "part.assetName");
    const asset = assetsByName.get(assetName);
    if (!asset) throw new Error("角色部件资产未托管：" + assetName);
    return {
      tag: requireString(raw.tag, "part.tag"),
      assetName,
      xyxy: readXyxy(raw.xyxy, assetName),
      depthMedian: requireNumber(raw.depthMedian, assetName + ".depthMedian"),
      partId: typeof raw.partId === "number" && Number.isInteger(raw.partId) ? raw.partId : null,
      url: asset.url,
    };
  });
  return TaskResultSchema.parse({
    ...result,
    raw: { ...result.raw, characterDecomposition: { ...result.raw.characterDecomposition, parts } },
  });
}
