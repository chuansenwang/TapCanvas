import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 解析可执行 Python 命令。
 *
 * 优先 `uv run python`（仓库既有约定），其次项目虚拟环境，最后 PATH 上的
 * `python`。全部不可用时显式失败，不猜测解释器。
 */
export function resolvePythonCommand({ env = process.env, existsSync = fs.existsSync, which = defaultWhich } = {}) {
  const configured = (env.AIGC_PYTHON || "").trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`AIGC_PYTHON 指向的解释器不存在: ${configured}`);
    }
    return [configured];
  }
  if (which("uv")) return ["uv", "run", "python"];
  const venvPython = String.raw`F:\aigc\aigc\.venv\Scripts\python.exe`;
  if (existsSync(venvPython)) return [venvPython];
  if (which("python")) return ["python"];
  throw new Error("未找到可用的 Python 解释器：请安装 uv、创建 F:\\aigc\\aigc\\.venv，或设置 AIGC_PYTHON");
}

function defaultWhich(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf8" });
  return result.status === 0 && Boolean((result.stdout || "").trim());
}

function lastJsonLine(stdout) {
  const lines = (stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 调用 subtitle-transcribe skill 识别字幕。
 *
 * 失败即抛错并带上原始退出码与错误文本；不静默返回空字幕。
 */
export function runSubtitleTranscribe({ skillsRoot, videoPath, videoId, outputDir, mode, spawn = spawnSync }) {
  if (!skillsRoot) throw new Error("runSubtitleTranscribe 缺少 skillsRoot");
  if (!["auto", "youtube", "whisper"].includes(mode)) {
    throw new Error(`字幕识别模式只支持 auto|youtube|whisper，收到: ${mode}`);
  }
  const script = path.join(skillsRoot, "subtitle-transcribe", "scripts", "transcribe_subtitles.py");
  if (!fs.existsSync(script)) throw new Error(`未找到字幕识别脚本: ${script}`);
  if (!fs.existsSync(videoPath)) throw new Error(`本地媒体文件不存在: ${videoPath}`);

  const subtitlesDir = path.join(outputDir, "subtitles");
  fs.mkdirSync(subtitlesDir, { recursive: true });
  const [command, ...commandArgs] = resolvePythonCommand();
  const result = spawn(
    command,
    [
      ...commandArgs,
      script,
      "--media",
      videoPath,
      "--video-id",
      videoId,
      "--out-dir",
      subtitlesDir,
      "--mode",
      mode,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw new Error(`无法执行字幕识别：${result.error.message}`);
  const stdout = (result.stdout || "").trim();
  const payload = lastJsonLine(stdout);
  if (result.status !== 0 || !payload || payload.status === "failed") {
    const detail = payload?.error || (result.stderr || stdout || "未知字幕识别错误").trim();
    throw new Error(`字幕识别失败（mode=${mode}，退出码 ${result.status}）：${detail}`);
  }
  const segmentsPath = payload.artifacts?.segments;
  if (!segmentsPath || !fs.existsSync(segmentsPath)) {
    throw new Error("字幕识别返回成功但未生成 segments JSON");
  }
  const artifact = JSON.parse(fs.readFileSync(segmentsPath, "utf8"));
  return {
    requestedMode: mode,
    status: payload.status ?? "ok",
    reusedSourceMode: payload.reusedSourceMode ?? null,
    sourceKind: payload.source,
    captionKind: payload.captionKind ?? null,
    speakerLabelling: payload.speakerLabelling ?? null,
    segmentCount: payload.segmentCount,
    durationSec: artifact.durationSec,
    youTubeErrorBeforeFallback: artifact.source?.youtube_error_before_fallback ?? null,
    report: payload.report,
    artifacts: payload.artifacts,
    segments: artifact.segments,
  };
}
