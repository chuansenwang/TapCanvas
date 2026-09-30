/**
 * MiniMax H3 音频的「台词 → 时长」换算合同。
 *
 * 背景：H3 音频不接受 duration 参数，音频长度完全由执行器提交的 `length`（帧数）决定，
 * 而该长度由提示词里的台词字数与时间轴预算推导。因此这里的语速常数不是一个无关紧要的
 * 经验值，而是直接决定成品长度：估长了尾部会留出大片静音，估短了模型会赶读甚至截断。
 *
 * 为什么必须区分语种：旧实现用单一常数 4.5 字/秒（中文经验值）处理所有台词。中文与
 * 英文的单位字符信息量差异很大（英文按字母计，且单词间有空格），用中文语速估算英文
 * 台词会把时长抬高到实际需要的两倍以上——实测一条 53 字符的英文台词被请求 14.375 秒，
 * 而真实人声在 8.25 秒就结束了，尾部留下 6.13 秒静音。
 *
 * 常数来源：
 * 1) 对本机 ComfyUI 历史中 16 条真实 H3 产物的 `ffmpeg` 响度包络做回归——中文样本
 *    实测约 2.6~3.8 字/秒，且产物普遍填满请求时长（尾部静音≈0），说明中文 4.5 的
 *    既有配平已被真实产物验证，保持不变。
 * 2) 拉丁侧用真实生成校准：一条 116 字符的英文台词在 12.167 秒请求下人声一直说到
 *    12.26 秒（尾部仅 0.05 秒），已接近「估短」；解出拉丁自然语速约 9.6~11 字符/秒。
 *    因此取 10 —— 刻意偏向「略估长」：H3 会把台词铺满请求时长，估短会让模型赶读甚至
 *    截断，估长最多留一点尾部静音，代价小得多。
 */

/** 中文/日文/韩文等表意文字语速（字/秒）。 */
export const H3_CJK_CHARS_PER_SECOND = 4.5;

/** 拉丁等字母文字语速（字符/秒，不含空白）。 */
export const H3_LATIN_CHARS_PER_SECOND = 10;

/** 开场静默秒数：规避 H3 段首约 1 秒的伪影区。 */
export const H3_OPENING_SILENCE_SECONDS = 1;

/** 句间停顿秒数。 */
export const H3_LINE_GAP_SECONDS = 0.6;

/** 单句最短占位秒数。 */
export const H3_MIN_LINE_SECONDS = 1.5;

/** 收尾留白秒数。 */
export const H3_TAIL_SECONDS = 1.5;

/** 单次生成的时长硬区间（秒）。 */
export const H3_MIN_DURATION_SECONDS = 1;
export const H3_MAX_DURATION_SECONDS = 15;

/**
 * 提取提示词里的时间轴时间戳（秒）。
 *
 * 必须同时接受 `At MM:SS.mmm` 与 agent 手写的 `At exactly MM:SS.mmm`：旧实现只匹配前者，
 * 导致手写结构化提示词的时间轴预算恒为 0（只剩台词字数预算），时长被低估。
 * 每次调用新建正则，避免 `g` 标志在多次调用间共享 `lastIndex` 状态。
 */
export function h3TimelineTimestamps(prompt: string): number[] {
  return Array.from(
    prompt.matchAll(/At\s+(?:exactly\s+)?(\d{1,2}):(\d{2}\.\d{3})/gu),
    (match) => Number(match[1]) * 60 + Number(match[2]),
  );
}

/** 该字符是否属于 CJK 表意文字（含假名与谚文），用于选择语速常数。 */
export function isH3CjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * 一段台词的口播秒数：按字符集分别用中文/拉丁语速累加，不做语义判断。
 * 纯空白返回 0，由调用方决定如何处理空台词。
 */
export function h3SpeakingSeconds(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    if (isH3CjkChar(char)) cjk += 1;
    else latin += 1;
  }
  return cjk / H3_CJK_CHARS_PER_SECOND + latin / H3_LATIN_CHARS_PER_SECOND;
}
