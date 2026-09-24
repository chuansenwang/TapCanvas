#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePythonCommand, runSubtitleTranscribe } from "./lib/subtitle-bridge.mjs";
import { probeDurationSec, probeFrameRate, runFfmpeg } from "./lib/media-tools.mjs";
import {
  DEFAULT_MIN_CUT_GAP_SEC,
  DEFAULT_SCENE_THRESHOLD,
  detectShots,
  loadReusableShots,
} from "./lib/shot-detection.mjs";

// 从脚本自身位置推导，避免相对层级写错把 repoRoot 指到 TapCanvas 之外。
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(scriptDir);
const skillsRoot = path.dirname(skillDir);
const repoRoot = path.dirname(path.dirname(skillsRoot));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    args[key.slice(2)] = value && !value.startsWith("--") ? value : true;
    if (args[key.slice(2)] !== true) i += 1;
  }
  return args;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

// mimeType 按真实文件扩展名给出，避免把 webm/mkv 记成 video/mp4。
function mimeTypeForPath(videoPath) {
  const extension = path.extname(videoPath).toLowerCase();
  const table = {
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
  };
  return table[extension] ?? "application/octet-stream";
}

// 拼图按 5×4 = 20 格一张，单格宽 320，便于一次读取多帧证据。
const SHEET_COLUMNS = 5;
const SHEET_ROWS = 4;
const SHEET_CELLS = SHEET_COLUMNS * SHEET_ROWS;
const SHEET_CELL_WIDTH = 320;

function frameVariantName({ mode, intervalSec, threshold, minCutGapSec }) {
  return mode === "scene"
    ? `scene-${threshold.toFixed(2)}-gap${minCutGapSec}`
    : `interval-${intervalSec}s`;
}

// 间隔模式：按固定间隔均匀抽样候选帧。这是证据点，不是镜头边界。
function buildIntervalFilter(intervalSec) {
  return `fps=1/${intervalSec},scale=960:-1`;
}

// 用源文件身份（绝对路径 + 大小 + 修改时间）给候选帧目录做指纹：
// 只有同一份视频、同一抽帧参数才会命中同一目录，视频被替换时自动落到新目录，
// 既不会把旧帧当成新证据，也不需要删除任何已有产物。
function sourceFingerprint(videoPath) {
  const stat = fs.statSync(videoPath);
  return crypto
    .createHash("sha256")
    .update(`${videoPath}\n${stat.size}\n${Math.round(stat.mtimeMs)}`)
    .digest("hex")
    .slice(0, 12);
}

function listCandidateFrames(framesDir) {
  if (!fs.existsSync(framesDir)) return [];
  return fs.readdirSync(framesDir)
    .filter((name) => /^frame-\d{4}\.png$/i.test(name))
    .sort()
    .map((name) => path.join(framesDir, name));
}

/**
 * 把候选帧拼成 contact sheet，减少逐张读取的开销。
 *
 * ffmpeg 的 `tile` 会用最后一帧重复填充空位（已实测：13 张帧拼 5×4 时，
 * 第 14..20 格与第 13 格 MD5 完全相同）。因此每张拼图都同时记录真实帧号列表与
 * 填充格数量，避免把重复填充当成额外证据点。
 */
function buildContactSheets({ frames, sheetsDir, variant }) {
  fs.mkdirSync(sheetsDir, { recursive: true });
  const sheets = [];
  for (let start = 0; start < frames.length; start += SHEET_CELLS) {
    const batch = frames.slice(start, start + SHEET_CELLS);
    const sheetIndex = sheets.length + 1;
    const sheetPath = path.join(sheetsDir, `sheet-${String(sheetIndex).padStart(3, "0")}.png`);
    if (!fs.existsSync(sheetPath)) {
      runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-start_number",
        String(start + 1),
        "-i",
        path.join(path.dirname(batch[0]), "frame-%04d.png"),
        "-vf",
        `scale=${SHEET_CELL_WIDTH}:-1,tile=${SHEET_COLUMNS}x${SHEET_ROWS}`,
        "-frames:v",
        "1",
        sheetPath,
      ]);
    }
    sheets.push({
      path: sheetPath,
      layout: `${SHEET_COLUMNS}x${SHEET_ROWS}`,
      frameNumbers: batch.map((framePath) => frameNumber(framePath)),
      paddingCells: SHEET_CELLS - batch.length,
      frameVariant: variant,
    });
  }
  return sheets;
}

function frameNumber(framePath) {
  const match = /frame-(\d{4})\.png$/i.exec(framePath);
  return match ? Number(match[1]) : null;
}

function runDownloader(url, outputRoot) {
  const script = path.join(skillsRoot, "video-downloader", "scripts", "download_video.py");
  const [command, ...commandArgs] = resolvePythonCommand();
  const result = spawnSync(command, [
    ...commandArgs,
    script,
    "--out-root",
    outputRoot,
    "--title",
    "youtube-storyboard",
    "--quality",
    "1080",
    "--no-invidious-fallback",
    url,
  ], { encoding: "utf8" });
  if (result.error) throw new Error(`无法调用 video-downloader：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "未知下载错误").trim();
    throw new Error(`video-downloader 失败（退出码 ${result.status}）：${detail}`);
  }
  const outputDir = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse()
    .find((line) => fs.existsSync(line));
  if (!outputDir || !fs.existsSync(outputDir)) throw new Error("video-downloader 未返回有效输出目录");
  return outputDir;
}

/**
 * 找与本地视频同名的 `.info.json`（yt-dlp 的命名约定是 `<名称>.info.json` 配 `<名称>.mp4`）。
 *
 * 目录里可能存在别的视频的元数据；按同名匹配可以避免把另一个视频的标题/时长
 * 悄悄套在当前视频上。匹配不到时返回空对象，由调用方从媒体本身探测事实。
 */
function findSiblingMetadata(videoPath) {
  const expected = `${path.basename(videoPath).replace(/\.[^.]+$/, "")}.info.json`;
  const match = fs.readdirSync(path.dirname(videoPath))
    .find((name) => name.toLowerCase() === expected.toLowerCase());
  if (!match) return {};
  return JSON.parse(fs.readFileSync(path.join(path.dirname(videoPath), match), "utf8"));
}

const args = parseArgs(process.argv);
if (args.help || (!args.url && !args.media)) {
  process.stdout.write(
    "用法：node prepare-youtube.mjs --url <YouTube URL> [--format json] [--subtitles auto|youtube|whisper] " +
      "[--frame-mode scene|interval] [--scene-threshold 0.25] [--min-cut-gap 0.1] [--frame-interval 15]\n" +
      "      node prepare-youtube.mjs --media <本地视频> [--format json] [--subtitles whisper] " +
      "[--metadata <info.json>] [--frame-mode scene|interval] [--scene-threshold 0.25] [--min-cut-gap 0.1] " +
      "[--frame-interval 15]\n\n" +
      "  --frame-mode scene（默认）：ffmpeg 全帧率场景检测，输出镜头边界与逐镜头代表帧。\n" +
      "  --frame-mode interval：按固定间隔均匀抽样候选帧，只作画面证据点，不做切点。\n",
  );
  process.exitCode = args.help ? 0 : 2;
} else {
  try {
    // 用户直接给本地视频时不需要 URL：跳过 video-downloader，只做抽帧与可选字幕识别。
    const url = args.url ? String(args.url).trim() : null;
    if (url && !/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) {
      throw new Error("--url 不是受支持的 YouTube URL");
    }
    // 参数错误必须在下载大文件之前暴露，避免报错发生在无关阶段。
    if (args.subtitles && !["auto", "youtube", "whisper", "none"].includes(String(args.subtitles))) {
      throw new Error(`--subtitles 只支持 auto|youtube|whisper|none，收到: ${args.subtitles}`);
    }
    const frameMode = args["frame-mode"] ? String(args["frame-mode"]) : "scene";
    if (!["interval", "scene"].includes(frameMode)) {
      throw new Error(`--frame-mode 只支持 interval|scene，收到: ${frameMode}`);
    }
    const frameIntervalSec = args["frame-interval"] ? Number(args["frame-interval"]) : 15;
    if (!Number.isFinite(frameIntervalSec) || frameIntervalSec <= 0) {
      throw new Error(`--frame-interval 必须是正数秒，收到: ${args["frame-interval"]}`);
    }
    const sceneThreshold = args["scene-threshold"]
      ? Number(args["scene-threshold"])
      : DEFAULT_SCENE_THRESHOLD;
    if (!Number.isFinite(sceneThreshold) || sceneThreshold < 0 || sceneThreshold > 1) {
      throw new Error(`--scene-threshold 必须是 0..1 之间的数值，收到: ${args["scene-threshold"]}`);
    }
    const minCutGapSec = args["min-cut-gap"]
      ? Number(args["min-cut-gap"])
      : DEFAULT_MIN_CUT_GAP_SEC;
    if (!Number.isFinite(minCutGapSec) || minCutGapSec < 0) {
      throw new Error(`--min-cut-gap 必须是非负数秒，收到: ${args["min-cut-gap"]}`);
    }

    let outputDir;
    let videoPath;
    let metadata;
    if (args.media) {
      // 用户提供的本地视频（含已下载视频）：不再联网重下，避免分镜流程重复拉取大文件。
      videoPath = path.resolve(String(args.media));
      if (!fs.existsSync(videoPath)) throw new Error(`--media 指定的视频不存在: ${videoPath}`);
      if (!/\.(mp4|webm|mov|m4v|mkv)$/i.test(videoPath)) {
        throw new Error(`--media 不是受支持的视频格式: ${videoPath}`);
      }
      outputDir = path.dirname(videoPath);
      if (args.metadata) {
        const metadataPath = path.resolve(String(args.metadata));
        if (!fs.existsSync(metadataPath)) throw new Error(`--metadata 指定的文件不存在: ${metadataPath}`);
        metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      } else {
        metadata = findSiblingMetadata(videoPath);
      }
    } else {
      const outputRoot = args.downloadDir
        ? path.resolve(String(args.downloadDir))
        : path.join(repoRoot, ".runtime", "youtube-storyboard", "downloads");
      outputDir = runDownloader(url, outputRoot);
      const reportPath = path.join(outputDir, "download-report.json");
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      const record = report.records?.find((item) => item.url === url && item.status === "ok");
      videoPath = record?.files?.find((file) => /\.(mp4|webm|mov|m4v|mkv)$/i.test(file));
      if (!videoPath || !fs.existsSync(videoPath)) throw new Error("video-downloader 报告成功但未找到视频文件");
      const infoPath = fs.readdirSync(outputDir).find((name) => /\.info\.json$/i.test(name));
      metadata = infoPath ? JSON.parse(fs.readFileSync(path.join(outputDir, infoPath), "utf8")) : {};
    }
    const directVideoUrl = typeof metadata.url === "string"
      ? metadata.url
      : metadata.requested_formats?.find((item) => typeof item?.url === "string")?.url;
    // 本地视频没有媒体直链是正常事实：分镜证据来自本地文件抽帧，不能凭此失败，也不能伪造直链。
    if (!directVideoUrl && !args.media) {
      throw new Error(
        "未找到可读取的媒体直链：请保留 video-downloader 生成的 .info.json，或通过 --metadata 指定",
      );
    }
    // 本地视频缺少元数据时，时长必须从媒体本身探测；探测失败即显式失败，不留 null 让下游猜。
    const durationSec = typeof metadata.duration === "number" ? metadata.duration : probeDurationSec(videoPath);

    // 抽帧参数与源文件指纹一起写进目录名：重跑换参数、换视频都不会与旧产物混在一起，
    // 也不需要删除任何已有文件。
    const frameVariant = `${frameVariantName({
      mode: frameMode,
      intervalSec: frameIntervalSec,
      threshold: sceneThreshold,
      minCutGapSec,
    })}-${sourceFingerprint(videoPath)}`;
    const framesDir = path.join(outputDir, `candidate-frames-${frameVariant}`);
    // scene 模式产出镜头边界与逐镜头代表帧；interval 模式只产出均匀抽样证据点。
    let shots = null;
    let frameExtraction;
    if (frameMode === "scene") {
      const frameRate = probeFrameRate(videoPath);
      const boundariesPath = path.join(outputDir, `shot-boundaries-${frameVariant}.json`);
      // 同视频同参数已算过时直接复用，避免重复解码整片；参数变化必然落到新目录，不会串用。
      const reusable = loadReusableShots({
        boundariesPath,
        framesDir,
        durationSec,
        frameRate,
        threshold: sceneThreshold,
        minCutGapSec,
      });
      const detection = reusable ?? detectShots({
        videoPath,
        durationSec,
        frameRate,
        framesDir,
        logPath: path.join(outputDir, `scene-cuts-${frameVariant}.txt`),
        threshold: sceneThreshold,
        minCutGapSec,
      });
      shots = detection.shots;
      if (!reusable) {
        // 镜头边界单独落盘：交付后仍可复核，不必为看时间码重跑整片解码。
        fs.writeFileSync(
          boundariesPath,
          `${JSON.stringify(
            {
              schemaVersion: "youtube-storyboard-shots/v1",
              localVideoPath: videoPath,
              durationSec,
              frameRate,
              sceneThreshold: detection.threshold,
              minCutGapSec: detection.minCutGapSec,
              rawCutCount: detection.rawCutCount,
              cutCount: detection.cutCount,
              shots,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
      frameExtraction = {
        tool: "ffmpeg",
        format: "png",
        mode: "scene",
        intervalSec: null,
        sceneThreshold: detection.threshold,
        minCutGapSec: detection.minCutGapSec,
        frameRate,
        rawCutCount: detection.rawCutCount,
        cutCount: detection.cutCount,
        shotCount: shots.length,
        reused: Boolean(reusable),
        boundariesFile: boundariesPath,
      };
    } else {
      fs.mkdirSync(framesDir, { recursive: true });
      const framesBefore = listCandidateFrames(framesDir);
      // 同参数目录已有候选帧时直接复用，避免重复解码整片；复用事实会在输出里显式标注。
      const reusedFrames = framesBefore.length > 0;
      if (!reusedFrames) {
        runFfmpeg([
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          videoPath,
          "-vf",
          buildIntervalFilter(frameIntervalSec),
          "-vsync",
          "vfr",
          path.join(framesDir, "frame-%04d.png"),
        ]);
      }
      frameExtraction = {
        tool: "ffmpeg",
        format: "png",
        mode: "interval",
        intervalSec: frameIntervalSec,
        sceneThreshold: null,
        minCutGapSec: null,
        frameRate: null,
        rawCutCount: null,
        cutCount: null,
        shotCount: null,
        reused: reusedFrames,
      };
    }
    const candidateFrames = listCandidateFrames(framesDir);
    if (candidateFrames.length === 0) throw new Error(`ffmpeg 未产出候选帧：${framesDir}`);
    const contactSheets = buildContactSheets({
      frames: candidateFrames,
      sheetsDir: path.join(outputDir, `candidate-sheets-${frameVariant}`),
      variant: frameVariant,
    });

    const videoId = typeof metadata.id === "string" && metadata.id
      ? metadata.id
      : path.basename(videoPath).replace(/\.[^.]+$/, "");
    let subtitles = null;
    if (args.subtitles && args.subtitles !== "none") {
      const mode = String(args.subtitles);
      subtitles = runSubtitleTranscribe({ skillsRoot, videoPath, videoId, outputDir, mode });
    }

    const output = {
      source: {
        url,
        videoId,
        title: typeof metadata.title === "string" && metadata.title
          ? metadata.title
          : path.basename(videoPath).replace(/\.[^.]+$/, ""),
        durationSec,
        channel: typeof metadata.channel === "string" ? metadata.channel : "unknown",
        publishedAt: typeof metadata.upload_date === "string" ? metadata.upload_date : "unknown",
        directVideoUrl: directVideoUrl ?? null,
        mimeType: mimeTypeForPath(videoPath),
        localVideoPath: videoPath,
        // scene 模式下 candidateFrames 与 shots 一一对应（每个镜头一张代表帧）；
        // interval 模式下候选帧只是均匀抽样证据点，shots 为 null。
        shots,
        candidateFrames,
        contactSheets,
        frameExtraction,
        subtitles,
      },
    };
    if (args.format === "json") process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      process.stdout.write(
        `${output.source.title} (${output.source.videoId})\n` +
          `${output.source.directVideoUrl ?? output.source.localVideoPath}\n`,
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
