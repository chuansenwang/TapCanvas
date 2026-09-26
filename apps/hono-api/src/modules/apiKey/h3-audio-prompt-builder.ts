/**
 * MiniMax H3 音频「简易模式」提示词构造。
 *
 * 背景：H3 音频执行器要求结构化提示词（固定段落名 + `<d>` 台词标签 + 时间轴），
 * 用户在画布音频节点里输入的是一句普通台词，直接提交必然缺少必需段落。
 * 上游 TTS 服务本身也提供同语义的「B 模式（简易模式）」：由调用方给出台词，
 * 服务端套用模板生成提示词。本模块把该模式落到我们的执行链路上。
 *
 * 边界：
 * - 仅做结构组装，不做语义理解 —— 不识别意图、不判断剧情、不改写台词文字。
 * - 判断「是否已经是结构化提示词」用的是段落名存在性（结构校验），不是关键词语义匹配。
 * - 已经满足 H3 音频合同的提示词一律原样透传，不被模板覆盖。
 */

import { validateH3AudioPromptContract } from "../task/h3-prompt-contract";

/**
 * H3 音频提示词的全部段落名。用于区分「用户输入的是普通台词」与
 * 「用户写了结构化提示词但结构损坏」——后者必须显式失败，不得降级重打包。
 */
const H3_AUDIO_SECTION_NAMES = [
  "integrated_multimodal_description",
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;

/** 该行是否是某个 H3 段落名声明（与契约校验同口径的结构判定）。 */
function hasSectionField(prompt: string, field: string): boolean {
  return prompt
    .split(/\r?\n/u)
    .some((line) => line.trimStart().startsWith(`${field}:`));
}

/** 中文语速经验值（字/秒），与执行器时长估算和 H3 音频 Skill 保持一致。 */
const CHARS_PER_SECOND = 4.5;
/** 开场静默秒数：规避 H3 段首约 1 秒的伪影区。 */
const OPENING_SILENCE_SECONDS = 1;
/** 句间停顿秒数。 */
const LINE_GAP_SECONDS = 0.6;
/** 单句最短占位秒数。 */
const MIN_LINE_SECONDS = 1.5;
/** 收尾留白秒数。 */
const TAIL_SECONDS = 1.5;

export type H3AudioPromptSource = "structured" | "plain_text";

export type ResolvedH3AudioPrompt = {
  prompt: string;
  source: H3AudioPromptSource;
};

function isCjkChar(char: string): boolean {
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
 * 台词语言标签。按字符集判定 CJK，属于机械分类而非语义识别；
 * 混排台词取 CJK 占比是否过半，与 H3 Skill 的「按该句主要发声语言标注」一致。
 */
function resolveLanguageTag(text: string): string {
  let cjk = 0;
  let latinOrDigit = 0;
  for (const char of text) {
    if (isCjkChar(char)) cjk += 1;
    else if (/[A-Za-z0-9]/.test(char)) latinOrDigit += 1;
  }
  if (cjk === 0 && latinOrDigit > 0) return "English";
  return "Chinese";
}

/** 把秒数格式化为 H3 时间轴要求的 `MM:SS.mmm`。 */
function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

/** 去掉空白后的字符数，用于语速预算。 */
function spokenLength(text: string): number {
  return text.replace(/\s/gu, "").length;
}

/** 单句占位秒数：不短于最短占位，按语速线性换算。 */
function lineSeconds(text: string): number {
  return Math.max(MIN_LINE_SECONDS, spokenLength(text) / CHARS_PER_SECOND);
}

/** 逐行拆出台词：每个非空行是一句独立台词，与上游 lines 数组语义一致。 */
export function splitDialogueLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export type H3DialogueShot = {
  index: number;
  startSeconds: number;
  timestamp: string;
  languageTag: string;
  text: string;
};

/** 按「开场静默 + 逐句语速」排布时间轴，供提示词与时长预算共用。 */
export function planH3DialogueShots(lines: readonly string[]): H3DialogueShot[] {
  const shots: H3DialogueShot[] = [];
  let cursor = OPENING_SILENCE_SECONDS;
  for (const [index, text] of lines.entries()) {
    shots.push({
      index: index + 1,
      startSeconds: cursor,
      timestamp: formatTimestamp(cursor),
      languageTag: resolveLanguageTag(text),
      text,
    });
    cursor += lineSeconds(text) + LINE_GAP_SECONDS;
  }
  return shots;
}

/** 由时间轴推算的整段时长（秒），用于摘要文案与超限提示。 */
export function planH3DialogueDuration(shoots: readonly H3DialogueShot[]): number {
  const last = shoots.at(-1);
  if (!last) return OPENING_SILENCE_SECONDS + TAIL_SECONDS;
  return last.startSeconds + lineSeconds(last.text) + TAIL_SECONDS;
}

function renderShots(shoots: readonly H3DialogueShot[], options: { voice: string }): string[] {
  // Shot 1 不写时间戳，只声明开场无人声；后续镜头逐句挂时间戳，与 H3 Skill 一致。
  const header = "[Shot 1] 画面开始的一秒内没有任何人声、杂声或呓语。";
  return [
    header,
    ...shoots.map((shot) =>
      `[Shot ${shot.index + 1}] At ${shot.timestamp}, ${options.voice}、自然的语气说：<d>[${shot.languageTag}] ${shot.text}</d>`,
    ),
  ];
}

/**
 * 声场段落：默认 `N/A`（只出干净人声）。
 *
 * H3 官方指南规定 `overall_soundscape` 只有在用户明确要求「全程静音」时才写 `N/A`，
 * 但只要在正文里描述环境声，模型就会真的铺一层环境床——这正是此前「所有音色都带背景音」
 * 的来源。简易模式的语义是「把这段台词念出来」，用户没有要求环境声，
 * 因此默认输出 `N/A`，不主动追加任何环境声、底噪或配乐描述。
 */
const SOUNDSCAPE_SILENT = "N/A";

/** 无参考音：基础三段结构。 */
function buildTextModePrompt(shots: readonly H3DialogueShot[]): string {
  return [
    "integrated_multimodal_description:",
    ...renderShots(shots, { voice: "旁白说话人以 (S1) 的声音" }),
    "",
    "overall_soundscape:",
    SOUNDSCAPE_SILENT,
    "",
    "non_diegetic_music:",
    "N/A",
  ].join("\n");
}

/** 有参考音：Ref2VA 六段结构，音色引用执行器支持的 `@1` 别名。 */
function buildReferenceModePrompt(lines: readonly string[], shots: readonly H3DialogueShot[], duration: number): string {
  return [
    "subject_definitions:",
    "<Subject 1> 是旁白说话人，外观由文本定义。说话人使用 (S1) 的声音，音色完全参照 @1（自然人声，语气自然）。只借用 @1 的音色，不复述参考音频中的任何内容。",
    "全片只有 1 名说话人物，(S1) 永远是说话人的声音，不得混淆、不得互换、不得新增其他人物或任何人声。画面开始的一秒内没有任何人声、杂声或呓语。",
    "",
    "summary:",
    `[reference generation + audio reference] 一段约 ${duration.toFixed(0)} 秒的纯语音，共 ${lines.length} 句台词，说话人依次念出，声音使用 @1 的音色。开场无人声。`,
    "",
    "retention_analysis:",
    "@1（说话人音色来源）：voice_timbre_only - 仅保留音色特征，不复制参考音频的语音内容，参考音频中的话语不得出现在成品中。",
    "说话人外观由文本定义。全程不增加其他人物或相似人物。",
    "",
    "detailed_description:",
    ...renderShots(shots, { voice: "说话人以 (S1) 的声音、@1 的音色" }),
    "",
    "overall_soundscape:",
    SOUNDSCAPE_SILENT,
    "",
    "non_diegetic_music:",
    "N/A",
  ].join("\n");
}

/**
 * 把普通台词文本组装成满足 H3 音频合同的结构化提示词。
 * `referenceAudioCount > 0` 时产出六段式，否则产出三段式。
 */
export function buildH3AudioPromptFromDialogue(input: {
  text: string;
  referenceAudioCount: number;
}): string {
  const lines = splitDialogueLines(input.text);
  if (lines.length === 0) {
    throw new Error("H3 音频简易模式需要非空台词文本");
  }
  const shots = planH3DialogueShots(lines);
  const duration = planH3DialogueDuration(shots);
  return input.referenceAudioCount > 0
    ? buildReferenceModePrompt(lines, shots, duration)
    : buildTextModePrompt(shots);
}

/**
 * 解析最终提交给 H3 执行器的提示词。
 * 已满足合同的提示词原样透传；普通台词按简易模式组装。
 */
export function resolveH3AudioPrompt(input: {
  prompt: string;
  referenceAudioCount: number;
}): ResolvedH3AudioPrompt {
  const text = input.prompt.trim();
  const existing = validateH3AudioPromptContract({
    prompt: text,
    referenceAudioCount: input.referenceAudioCount,
  });
  if (existing.ok) return { prompt: text, source: "structured" };
  // 已经写了 H3 段落名、却缺必需段落时，说明这是「损坏的结构化提示词」，
  // 不是普通台词。此时套用简易模式会把整段结构当成台词逐行重打包
  // （`<d>` 嵌套、段落名被念出来），把 1 句台词放大成几十秒的伪请求。
  // 按仓库的显式失败原则，这里必须原地报错并指明缺失段落，不得降级重打包。
  const declaredSections = H3_AUDIO_SECTION_NAMES.filter((field) => hasSectionField(text, field));
  if (declaredSections.length > 0) {
    throw new Error(
      "H3 音频提示词结构不完整：已声明段落 " +
      `${declaredSections.join("、")}，但缺少必需段落 ${existing.missing.join("、")}。` +
      "请补齐缺失段落；如果只想生成普通配音，请改为只输入纯台词文本，不要混入段落名。",
    );
  }
  return {
    prompt: buildH3AudioPromptFromDialogue({
      text,
      referenceAudioCount: input.referenceAudioCount,
    }),
    source: "plain_text",
  };
}
