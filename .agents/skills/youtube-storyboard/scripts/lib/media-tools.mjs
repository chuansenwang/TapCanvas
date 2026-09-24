import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** 本机既有的 ffmpeg 安装位置，仓库内其它脚本也以此为默认值。 */
const WINDOWS_FFMPEG_DEFAULT = String.raw`D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe`;
const WINDOWS_FFPROBE_DEFAULT = String.raw`D:\soft\ffmpeg-master-latest-win64-gpl\bin\ffprobe.exe`;
const ENCODING = "utf8";
// ffmpeg 的 stderr 可能包含很长的滤镜诊断，默认 1MB 缓冲会在长视频上被撑爆。
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

function defaultWhich(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: ENCODING });
  return result.status === 0 && Boolean((result.stdout || "").trim());
}

/**
 * 解析外部媒体工具路径：显式覆盖 > 本机默认安装 > PATH。
 *
 * 找不到时显式失败，不静默退化成“跳过该步骤”——抽帧与时长探测都不能被跳过。
 */
function resolveTool({ override, windowsDefault, command, label, existsSync, which }) {
  const configured = String(override ?? "").trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`${label} 覆盖路径不存在: ${configured}`);
    }
    return configured;
  }
  if (existsSync(windowsDefault)) return windowsDefault;
  if (which(command)) return command;
  throw new Error(
    `未找到 ${label}：请设置环境变量，或把它加入 PATH（本机默认位置也缺失: ${windowsDefault}）`,
  );
}

export function resolveFfmpeg(options = {}) {
  const env = options.env ?? process.env;
  return resolveTool({
    override: env.FFMPEG_PATH,
    windowsDefault: WINDOWS_FFMPEG_DEFAULT,
    command: "ffmpeg",
    label: "ffmpeg",
    existsSync: options.existsSync ?? fs.existsSync,
    which: options.which ?? defaultWhich,
  });
}

export function resolveFfprobe(options = {}) {
  const env = options.env ?? process.env;
  return resolveTool({
    override: env.FFPROBE_PATH,
    windowsDefault: WINDOWS_FFPROBE_DEFAULT,
    command: "ffprobe",
    label: "ffprobe",
    existsSync: options.existsSync ?? fs.existsSync,
    which: options.which ?? defaultWhich,
  });
}

export function runFfmpeg(args, options = {}) {
  const executable = options.executable ?? resolveFfmpeg(options);
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(executable, args, {
    encoding: ENCODING,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  if (result.error) throw new Error(`无法执行 ffmpeg：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "未知错误").trim();
    throw new Error(`ffmpeg 退出码 ${result.status}：${detail.slice(-2000)}`);
  }
  return result;
}

export function runFfprobe(args, options = {}) {
  const executable = options.executable ?? resolveFfprobe(options);
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(executable, args, { encoding: ENCODING });
  if (result.error) throw new Error(`无法执行 ffprobe：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "未知错误").trim();
    throw new Error(`ffprobe 退出码 ${result.status}：${detail.slice(-2000)}`);
  }
  return result;
}

/**
 * 从媒体本身读出真实时长。
 *
 * 本地视频缺少 .info.json 时必须走这条路径；读不到就显式失败，不留 null 让下游猜。
 */
export function probeDurationSec(videoPath, options = {}) {
  const result = runFfprobe(
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    options,
  );
  const raw = (result.stdout || "").trim();
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe 未返回有效时长：${JSON.stringify(raw)}`);
  }
  return seconds;
}

/**
 * 读取视频真实帧率，用于把秒时间换算成帧号。
 *
 * 逐帧场景检测的抽帧按帧号定位，帧号算错会把代表帧落到错误的镜头里；
 * 因此 VFR（平均帧率与标称帧率不一致）必须显式失败，而不是按标称帧率硬算。
 */
export function probeFrameRate(videoPath, options = {}) {
  const result = runFfprobe(
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate,avg_frame_rate",
      "-of",
      "default=noprint_wrappers=1",
      videoPath,
    ],
    options,
  );
  const fields = {};
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const nominal = parseRational(fields.r_frame_rate);
  const average = parseRational(fields.avg_frame_rate);
  if (!Number.isFinite(nominal) || nominal <= 0) {
    throw new Error(`ffprobe 未返回有效帧率：${JSON.stringify(fields.r_frame_rate)}`);
  }
  // 浮点比较留出容差：30/1 与 30000/1001 这类写法不应被误判为 VFR。
  if (Number.isFinite(average) && average > 0 && Math.abs(average - nominal) > 0.01) {
    throw new Error(
      `视频为可变帧率（标称 ${nominal}fps，平均 ${average}fps），` +
        "逐帧场景检测按帧号定位会错位；请先用 ffmpeg 转成恒定帧率再拆分",
    );
  }
  return nominal;
}

function parseRational(value) {
  if (typeof value !== "string" || !value.includes("/")) return Number(value);
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return Number.NaN;
  }
  return numerator / denominator;
}
