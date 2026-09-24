import fs from "node:fs";
import path from "node:path";

import { runFfmpeg } from "./media-tools.mjs";

/**
 * 默认场景切换阈值。
 *
 * 依据两个真实视频（640x360 漫画剧情 28 分 20 秒、1280x720 动画 26 分 15 秒）的
 * 全帧率场景评分实测：阈值 0.3 会漏掉插入镜头与运镜切换（视频1 仅剩 17 个镜头），
 * 0.2 则把画面内运动也计入（视频1 涨到 56 个镜头）。0.25 下视频1/视频2 分别得到
 * 31/67 个镜头，经画面复核，多出来的切点均为真实剪辑，故取 0.25。
 */
export const DEFAULT_SCENE_THRESHOLD = 0.25;

/**
 * 合并同一处爆发的连续切点的时间间隔。
 *
 * ffmpeg 逐帧检测会把一次真实切换连报两帧（实测间隔 0.033 秒），不去重会产出两条
 * 零时长镜头。这里只合并同一处切点的重复上报，不合并相邻的不同镜头。
 */
export const DEFAULT_MIN_CUT_GAP_SEC = 0.1;

const EXTRACT_BATCH_SIZE = 150;

/**
 * 解析 ffmpeg `metadata=print` 的 `pts_time` 日志。
 *
 * 纯函数：只做文本到数值的转换，不读文件、不调用外部命令。日志形如
 * `frame:0 pts:162816 pts_time:10.6`，下一行为 `lavfi.scene_score=0.361871`；
 * 评分与时间码逐行配对，缺失评分时记为 null，不臆造数值。
 */
export function parseSceneLog(text) {
  const cuts = [];
  let pendingCut = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const timeMatch = /pts_time:([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (timeMatch) {
      const timeSec = Number(timeMatch[1]);
      // 收尾上一对：上一个切点若始终没等到评分，如实记为 null。
      if (pendingCut) cuts.push(pendingCut);
      pendingCut = Number.isFinite(timeSec) ? { timeSec, score: null } : null;
      continue;
    }
    const scoreMatch = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (scoreMatch && pendingCut) pendingCut.score = Number(scoreMatch[1]);
  }
  if (pendingCut) cuts.push(pendingCut);
  return cuts;
}

/**
 * 合并相邻过近的切点，只保留每个爆发处的第一个。
 *
 * 纯函数。输入需按 timeSec 升序；这里是同一处切点的去重，不是镜头合并。
 */
export function dedupeCuts(cuts, minGapSec = DEFAULT_MIN_CUT_GAP_SEC) {
  const accepted = [];
  for (const cut of cuts) {
    const previous = accepted[accepted.length - 1];
    if (previous === undefined || cut.timeSec - previous.timeSec >= minGapSec) {
      accepted.push(cut);
    }
  }
  return accepted;
}

/**
 * 由切点构建镜头区间，首尾补上 0 与视频时长。
 *
 * 纯函数。每个镜头取中点作为代表帧时间，避免落在切换过渡帧上。
 */
export function buildShots({ cuts, durationSec, frameRate }) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`构建镜头区间需要有效时长，收到: ${durationSec}`);
  }
  const boundaries = [{ timeSec: 0, cutScore: null }];
  for (const cut of cuts) {
    // 切点必须严格落在视频内部，否则会产生零时长或越界镜头。
    if (cut.timeSec > 0 && cut.timeSec < durationSec) {
      boundaries.push({ timeSec: cut.timeSec, cutScore: cut.score ?? null });
    }
  }
  boundaries.push({ timeSec: durationSec, cutScore: null });

  const lastFrameNumber = Math.max(0, Math.floor(durationSec * frameRate) - 1);
  const shots = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startSec = boundaries[index].timeSec;
    const endSec = boundaries[index + 1].timeSec;
    const shotDurationSec = endSec - startSec;
    if (shotDurationSec <= 0) continue;
    const sampleTimeSec = startSec + shotDurationSec / 2;
    shots.push({
      shotIndex: shots.length + 1,
      startSec: round3(startSec),
      endSec: round3(endSec),
      durationSec: round3(shotDurationSec),
      sampleTimeSec: round3(sampleTimeSec),
      frameNumber: Math.min(lastFrameNumber, Math.max(0, Math.round(sampleTimeSec * frameRate))),
      cutScore: boundaries[index].cutScore,
    });
  }
  return shots;
}

function round3(value) {
  return Number(value.toFixed(3));
}

/**
 * 在全帧率上跑场景检测，返回真实切点。
 *
 * 必须在原始帧率上检测：先降到 1fps 再检测会把 1 秒的帧间差放大成“场景切换”，
 * 实测同一视频同一阈值下切点会从 17 个虚增到 237 个。
 */
export function detectSceneCuts({ videoPath, threshold = DEFAULT_SCENE_THRESHOLD, logPath, ffmpegOptions = {} }) {
  // ffmpeg 的 `metadata=print:file=` 会把路径里的 `:` 当成选项分隔符，Windows 绝对路径
  // （如 `F:\...`）会直接导致滤镜解析失败。因此切到日志所在目录、只传裸文件名。
  const logDir = path.dirname(logPath);
  const logName = path.basename(logPath);
  fs.mkdirSync(logDir, { recursive: true });
  // ffmpeg 的 metadata 输出会截断已有文件，重复运行不会追加旧结果。
  runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-an",
      "-vf",
      `select='gt(scene,${threshold})',metadata=print:file=${logName}`,
      "-fps_mode",
      "passthrough",
      "-f",
      "null",
      "-",
    ],
    { ...ffmpegOptions, cwd: logDir },
  );
  if (!fs.existsSync(logPath)) {
    throw new Error(`场景检测未生成切点日志：${logPath}`);
  }
  const cuts = parseSceneLog(fs.readFileSync(logPath, "utf8"));
  return cuts.sort((left, right) => left.timeSec - right.timeSec);
}

/**
 * 按镜头代表帧号批量抽取图片。
 *
 * 用帧号而不是时间戳定位，避免容器时间基差异带来的偏移；抽帧数量与镜头数不一致时
 * 显式失败，不用“少几张也能用”掩盖问题。
 */
export function extractShotFrames({
  videoPath,
  shots,
  framesDir,
  scaleWidth = 640,
  ffmpegOptions = {},
}) {
  // 代表帧按 frame-0001..NNNN 连续编号，重跑时旧文件会与新结果混在一起，
  // 导致“抽帧数量与镜头数不一致”的误报；这里只清理本次产物目录内的图片。
  if (fs.existsSync(framesDir)) {
    for (const name of fs.readdirSync(framesDir)) {
      if (/^frame-\d{4}\.png$/i.test(name)) fs.rmSync(path.join(framesDir, name), { force: true });
    }
  }
  fs.mkdirSync(framesDir, { recursive: true });
  for (let offset = 0; offset < shots.length; offset += EXTRACT_BATCH_SIZE) {
    const batch = shots.slice(offset, offset + EXTRACT_BATCH_SIZE);
    const selectExpression = batch.map((shot) => `eq(n\\,${shot.frameNumber})`).join("+");
    runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoPath,
        "-vf",
        `select='${selectExpression}',scale=${scaleWidth}:-2`,
        "-fps_mode",
        "passthrough",
        "-start_number",
        String(offset + 1),
        path.join(framesDir, "frame-%04d.png"),
      ],
      ffmpegOptions,
    );
  }
  const frames = listFrames(framesDir);
  if (frames.length !== shots.length) {
    throw new Error(
      `镜头代表帧数量与镜头数不一致：镜头 ${shots.length}，实际抽帧 ${frames.length}（目录 ${framesDir}）；` +
        "请检查视频是否可完整解码",
    );
  }
  return frames;
}

function listFrames(framesDir) {
  if (!fs.existsSync(framesDir)) return [];
  return fs
    .readdirSync(framesDir)
    .filter((name) => /^frame-\d{4}\.png$/i.test(name))
    .sort()
    .map((name) => path.join(framesDir, name));
}

/**
 * 尝试复用上一次的镜头边界与代表帧。
 *
 * 只有边界文件里的参数与本次请求完全一致、且代表帧数量与镜头数吻合时才复用；
 * 任一条件不满足都返回 null，由调用方重新检测——绝不把旧参数的结果当作本次结果。
 */
export function loadReusableShots({
  boundariesPath,
  framesDir,
  durationSec,
  frameRate,
  threshold,
  minCutGapSec,
}) {
  if (!fs.existsSync(boundariesPath)) return null;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(boundariesPath, "utf8"));
  } catch {
    return null;
  }
  const sameRequest =
    payload.sceneThreshold === threshold &&
    payload.minCutGapSec === minCutGapSec &&
    Math.abs(Number(payload.durationSec) - durationSec) < 0.5 &&
    Math.abs(Number(payload.frameRate) - frameRate) < 0.01 &&
    Array.isArray(payload.shots) &&
    payload.shots.length > 0;
  if (!sameRequest) return null;
  const frames = listFrames(framesDir);
  if (frames.length !== payload.shots.length) return null;
  return {
    ...payload,
    shots: payload.shots.map((shot, index) => ({ ...shot, framePath: frames[index] })),
  };
}

/**
 * 一次性完成切点检测、去重、镜头区间构建与代表帧抽取。
 */
export function detectShots({
  videoPath,
  durationSec,
  frameRate,
  framesDir,
  logPath,
  threshold = DEFAULT_SCENE_THRESHOLD,
  minCutGapSec = DEFAULT_MIN_CUT_GAP_SEC,
  ffmpegOptions = {},
}) {
  const rawCuts = detectSceneCuts({ videoPath, threshold, logPath, ffmpegOptions });
  const cuts = dedupeCuts(rawCuts, minCutGapSec);
  const shots = buildShots({ cuts, durationSec, frameRate });
  const framePaths = extractShotFrames({ videoPath, shots, framesDir, ffmpegOptions });
  return {
    threshold,
    minCutGapSec,
    rawCutCount: rawCuts.length,
    cutCount: cuts.length,
    shots: shots.map((shot, index) => ({ ...shot, framePath: framePaths[index] })),
  };
}
