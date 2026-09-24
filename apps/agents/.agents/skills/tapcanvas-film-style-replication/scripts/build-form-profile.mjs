#!/usr/bin/env node
/**
 * 从已测得的镜头边界与字幕事实，生成可复用的“形式指纹”。
 *
 * 只做聚合，不做检测：镜头边界必须来自 `youtube-storyboard` 的
 * `prepare-youtube.mjs`（scene 模式），字幕必须来自 `subtitle-transcribe`。
 * 本脚本不重新解码视频，也不发明任何缺失维度。
 */

import fs from "node:fs";
import path from "node:path";

import { buildFormProfile, renderFormProfileMarkdown } from "./lib/form-profile.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      args[key.slice(2)] = value;
      index += 1;
    } else {
      args[key.slice(2)] = true;
    }
  }
  return args;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

/** 读取并解析 JSON；解析失败时带上真实路径与原因，不返回空对象顶替。 */
function readJson(filePath, label) {
  const resolved = path.resolve(String(filePath));
  if (!fs.existsSync(resolved)) throw new Error(`${label} 不存在: ${resolved}`);
  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`${label} 读取失败: ${resolved}（${error.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON: ${resolved}（${error.message}）`);
  }
}

/**
 * 从 prepare-youtube.mjs 的输出里取出镜头、时长与字幕。
 *
 * interval 模式下 `source.shots` 为 null——那条路径只产出画面证据点，没有镜头边界，
 * 不能拿来算形式指纹，这里显式失败并说明该换哪条路径。
 */
function readFromPrepare(payload, preparePath) {
  const source = payload?.source;
  if (!source || typeof source !== "object") {
    throw new Error(`prepare 输出缺少 source 字段: ${preparePath}`);
  }
  if (source.frameExtraction?.mode === "interval" || source.shots === null) {
    throw new Error(
      "prepare 输出来自 interval 模式，只有画面证据点、没有镜头边界；" +
        "请改用 prepare-youtube.mjs 的默认 scene 模式重新产出",
    );
  }
  if (!Array.isArray(source.shots) || source.shots.length === 0) {
    throw new Error(`prepare 输出缺少可用的 source.shots: ${preparePath}`);
  }
  if (!Number.isFinite(source.durationSec) || source.durationSec <= 0) {
    throw new Error(`prepare 输出缺少有效 durationSec: ${preparePath}`);
  }
  const subtitles = source.subtitles && typeof source.subtitles === "object" ? source.subtitles : null;
  return {
    shots: source.shots,
    durationSec: source.durationSec,
    segments: Array.isArray(subtitles?.segments) ? subtitles.segments : null,
    source: {
      videoId: source.videoId ?? null,
      title: source.title ?? null,
      localVideoPath: source.localVideoPath ?? null,
      sceneThreshold: source.frameExtraction?.sceneThreshold ?? null,
      minCutGapSec: source.frameExtraction?.minCutGapSec ?? null,
      frameRate: source.frameExtraction?.frameRate ?? null,
      subtitleSourceKind: subtitles?.sourceKind ?? null,
    },
  };
}

/** 从独立的镜头边界文件 + 字幕事实文件构造输入。 */
function readFromParts(args) {
  const boundaries = readJson(args.boundaries, "镜头边界文件");
  if (!Array.isArray(boundaries.shots) || boundaries.shots.length === 0) {
    throw new Error(`镜头边界文件缺少 shots: ${path.resolve(String(args.boundaries))}`);
  }
  let segments = null;
  if (args.subtitles) {
    const subtitlePayload = readJson(args.subtitles, "字幕事实文件");
    if (!Array.isArray(subtitlePayload.segments)) {
      throw new Error(`字幕事实文件缺少 segments: ${path.resolve(String(args.subtitles))}`);
    }
    segments = subtitlePayload.segments;
  }
  return {
    shots: boundaries.shots,
    durationSec: boundaries.durationSec,
    segments,
    source: {
      videoId: null,
      title: null,
      localVideoPath: boundaries.localVideoPath ?? null,
      sceneThreshold: boundaries.sceneThreshold ?? null,
      minCutGapSec: boundaries.minCutGapSec ?? null,
      frameRate: boundaries.frameRate ?? null,
      subtitleSourceKind: null,
    },
  };
}

const args = parseArgs(process.argv);

if (args.help || (!args.prepare && !args.boundaries)) {
  process.stdout.write(
    "用法：\n" +
      "  node build-form-profile.mjs --prepare <prepare-youtube 的 json 输出> [--format json|markdown]\n" +
      "  node build-form-profile.mjs --boundaries <shot-boundaries.json> [--subtitles <segments.json>] [--format json|markdown]\n" +
      "\n" +
      "  从已测得的镜头边界与字幕事实聚合形式指纹（镜头节奏 + 语速）。\n" +
      "  镜头边界需由 youtube-storyboard 的 prepare-youtube.mjs（scene 模式）产出；\n" +
      "  字幕需由 subtitle-transcribe 产出。本脚本不重新解码视频，也不补造缺失维度。\n",
  );
  process.exitCode = args.help ? 0 : 2;
} else {
  try {
    const format = args.format ? String(args.format) : "json";
    if (!["json", "markdown"].includes(format)) {
      throw new Error(`--format 只支持 json|markdown，收到: ${format}`);
    }

    let input;
    if (args.prepare) {
      const preparePath = path.resolve(String(args.prepare));
      input = readFromPrepare(readJson(preparePath, "prepare 输出"), preparePath);
    } else {
      input = readFromParts(args);
    }

    const profile = buildFormProfile(input);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    } else {
      process.stdout.write(renderFormProfileMarkdown(profile));
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
