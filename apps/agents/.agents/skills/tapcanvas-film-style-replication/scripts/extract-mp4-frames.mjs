#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const value = argv[index + 1];
    args[key.slice(2)] = value && !value.startsWith("--") ? value : true;
    if (args[key.slice(2)] !== true) index += 1;
  }
  return args;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bundledPath = "D:\\soft\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe";
  return fs.existsSync(bundledPath) ? bundledPath : "ffmpeg";
}

function runFfmpeg(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.error) throw new Error(`无法执行 ffmpeg：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "未知错误").trim();
    throw new Error(`ffmpeg 退出码 ${result.status}：${detail}`);
  }
  return result;
}

function parsePositiveNumber(value, optionName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} 必须是正数`);
  }
  return parsed;
}

function parseSceneThreshold(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error("--scene-threshold 必须大于 0 且小于 1");
  }
  return parsed;
}

function extractFrameTimes(logOutput) {
  const frameTimes = [];
  const matcher = /\bpts_time:([^\s]+)/g;
  let match = matcher.exec(logOutput);
  while (match) {
    const sourceTimeSec = Number(match[1]);
    if (Number.isFinite(sourceTimeSec) && sourceTimeSec >= 0) {
      frameTimes.push(sourceTimeSec);
    }
    match = matcher.exec(logOutput);
  }
  return frameTimes;
}

const args = parseArgs(process.argv);

if (args.help || !args.input) {
  process.stdout.write(
    "用法：node extract-mp4-frames.mjs --input <local.mp4> [--output-dir <directory>] [--scene-threshold <0-1>] [--max-width <pixels>] [--format json]\n",
  );
  process.exitCode = args.help ? 0 : 2;
} else {
  try {
    const inputPath = path.resolve(String(args.input));
    if (path.extname(inputPath).toLowerCase() !== ".mp4") {
      throw new Error("输入必须是本地 .mp4 文件");
    }
    if (!fs.existsSync(inputPath)) {
      throw new Error(`找不到输入 MP4：${inputPath}`);
    }
    if (!fs.statSync(inputPath).isFile()) {
      throw new Error(`输入路径不是文件：${inputPath}`);
    }

    const sceneThreshold = args["scene-threshold"]
      ? parseSceneThreshold(args["scene-threshold"])
      : 0.3;
    const maxWidth = args["max-width"]
      ? Math.trunc(parsePositiveNumber(args["max-width"], "--max-width"))
      : 960;
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputDir = args["output-dir"]
      ? path.resolve(String(args["output-dir"]))
      : path.join(resolveRepoRoot(), ".runtime", "film-style-replication", `${baseName}-frames`);
    fs.mkdirSync(outputDir, { recursive: true });

    const outputPattern = path.join(outputDir, "frame-%04d.png");
    const filter = `select=gt(scene\\,${sceneThreshold}),showinfo,scale=${maxWidth}:-1`;
    const result = runFfmpeg(resolveFfmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "info",
      "-i",
      inputPath,
      "-vf",
      filter,
      "-vsync",
      "vfr",
      outputPattern,
    ]);

    const framePaths = fs.readdirSync(outputDir)
      .filter((name) => /^frame-\d{4}\.png$/i.test(name))
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((name) => path.join(outputDir, name));
    if (framePaths.length === 0) {
      throw new Error("未抽取到候选 PNG 帧；请降低 --scene-threshold 或补充静态参考图");
    }

    const sourceTimes = extractFrameTimes(result.stderr || "");
    if (sourceTimes.length !== framePaths.length) {
      throw new Error(`抽帧时间码数量不一致：PNG ${framePaths.length} 张，时间码 ${sourceTimes.length} 个`);
    }

    const output = {
      source: {
        localVideoPath: inputPath,
        mimeType: "video/mp4",
      },
      frameExtraction: {
        tool: "ffmpeg",
        format: "png",
        strategy: "scene-transition-candidates",
        sceneThreshold,
        maxWidth,
      },
      sceneTransitions: sourceTimes.map((sourceTimeSec, index) => ({
        sourceTimeSec,
        candidateFramePath: framePaths[index],
      })),
      candidateFrames: framePaths.map((framePath, index) => ({
        localPath: framePath,
        sourceTimeSec: sourceTimes[index],
        source: "scene-transition-candidate",
      })),
    };
    if (args.format === "json") {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      output.candidateFrames.forEach((frame) => {
        process.stdout.write(`${frame.sourceTimeSec.toFixed(3)}s ${frame.localPath}\n`);
      });
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
