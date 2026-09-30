import path from "node:path";

/** 分镜产物目录的后缀：与视频文件同层、同名，便于在资源管理器里一眼对上归属。 */
export const STORYBOARD_DIR_SUFFIX = ".storyboard";

/**
 * 解析分镜产物目录。
 *
 * 一个视频的全部产物（候选帧、拼图、切点日志、镜头边界、字幕、prepare 输出）
 * 必须落在同一个专属目录里，绝不与视频文件平铺混放——否则同一目录下多个视频的
 * 产物只靠指纹后缀区分，人无法判断哪一批属于哪个视频。
 *
 * 纯函数：只做路径推导，不创建目录、不读文件系统。
 *
 * @param {{ videoPath: string, outDir?: string|null }} options
 *   `outDir` 显式给出时原样使用（调用方负责保证它是本次视频的专属目录）；
 *   否则返回 `<视频所在目录>/<视频文件名>.storyboard`。
 */
export function resolveStoryboardDir({ videoPath, outDir = null }) {
  const explicit = String(outDir ?? "").trim();
  if (explicit) return path.resolve(explicit);
  const stem = path.basename(videoPath).replace(/\.[^.]+$/, "");
  if (!stem) throw new Error(`无法从视频路径解析文件名: ${videoPath}`);
  return path.join(path.dirname(videoPath), `${stem}${STORYBOARD_DIR_SUFFIX}`);
}
