#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

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

function runFfmpeg(args) {
  const executable = process.env.FFMPEG_PATH || (fs.existsSync("D:\\soft\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe")
    ? "D:\\soft\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe"
    : "ffmpeg");
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.error) throw new Error(`无法执行 ffmpeg：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "未知错误").trim();
    throw new Error(`ffmpeg 退出码 ${result.status}：${detail}`);
  }
}

function runDownloader(url, outputRoot) {
  const script = path.join(repoRoot, "apps", "agents-cli", "skills", "z-video-downloader", "scripts", "download_video.py");
  const result = spawnSync("uv", [
    "run",
    "python",
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
  if (result.error) throw new Error(`无法调用 z-video-downloader：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "未知下载错误").trim();
    throw new Error(`z-video-downloader 失败（退出码 ${result.status}）：${detail}`);
  }
  const outputDir = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse()
    .find((line) => fs.existsSync(line));
  if (!outputDir || !fs.existsSync(outputDir)) throw new Error("z-video-downloader 未返回有效输出目录");
  return outputDir;
}

const args = parseArgs(process.argv);
if (args.help || !args.url) {
  process.stdout.write("用法：node prepare-youtube.mjs --url <YouTube URL> [--format json]\n");
  process.exitCode = args.help ? 0 : 2;
} else {
  try {
    const url = String(args.url).trim();
    if (!/^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) {
      throw new Error("输入不是受支持的 YouTube URL");
    }

    const outputRoot = args.downloadDir
      ? path.resolve(String(args.downloadDir))
      : path.join(repoRoot, ".runtime", "youtube-storyboard", "downloads");
    const outputDir = runDownloader(url, outputRoot);
    const reportPath = path.join(outputDir, "download-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const record = report.records?.find((item) => item.url === url && item.status === "ok");
    const videoPath = record?.files?.find((file) => /\.(mp4|webm|mov|m4v|mkv)$/i.test(file));
    if (!videoPath || !fs.existsSync(videoPath)) throw new Error("z-video-downloader 报告成功但未找到视频文件");
    const infoPath = fs.readdirSync(outputDir).find((name) => /\.info\.json$/i.test(name));
    const metadata = infoPath ? JSON.parse(fs.readFileSync(path.join(outputDir, infoPath), "utf8")) : {};
    const directVideoUrl = typeof metadata.url === "string"
      ? metadata.url
      : metadata.requested_formats?.find((item) => typeof item?.url === "string")?.url;
    if (!directVideoUrl) throw new Error("z-video-downloader 未在 info.json 中留下可读取的媒体直链");
    const durationSec = typeof metadata.duration === "number" ? metadata.duration : null;

    const framesDir = path.join(outputDir, "candidate-frames");
    fs.mkdirSync(framesDir, { recursive: true });
    runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      "select=gt(scene\\,0.30),scale=960:-1",
      "-vsync",
      "vfr",
      path.join(framesDir, "frame-%04d.png"),
    ]);
    const candidateFrames = fs.readdirSync(framesDir)
      .filter((name) => /^frame-\d{4}\.png$/i.test(name))
      .sort()
      .map((name) => path.join(framesDir, name));

    const output = {
      source: {
        url,
        videoId: typeof metadata.id === "string" ? metadata.id : "unknown",
        title: typeof metadata.title === "string" ? metadata.title : "unknown",
        durationSec,
        channel: typeof metadata.channel === "string" ? metadata.channel : "unknown",
        publishedAt: typeof metadata.upload_date === "string" ? metadata.upload_date : "unknown",
        directVideoUrl,
        mimeType: "video/mp4",
        localVideoPath: videoPath,
        candidateFrames,
        frameExtraction: { tool: "ffmpeg", format: "png", sceneThreshold: 0.3 },
      },
    };
    if (args.format === "json") process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else process.stdout.write(`${output.source.title} (${output.source.videoId})\n${output.source.directVideoUrl}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
