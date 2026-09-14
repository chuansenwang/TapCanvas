import { describe, expect, it } from "vitest";

import { validateH3AudioPromptContract } from "../task/h3-prompt-contract";
import {
  buildH3AudioPromptFromDialogue,
  planH3DialogueDuration,
  planH3DialogueShots,
  resolveH3AudioPrompt,
  splitDialogueLines,
} from "./h3-audio-prompt-builder";

describe("H3 音频简易模式", () => {
  it("把普通中文台词组装成满足音频合同的三段式提示词", () => {
    const prompt = buildH3AudioPromptFromDialogue({
      text: "你好亲爱的",
      referenceAudioCount: 0,
    });

    expect(validateH3AudioPromptContract({ prompt, referenceAudioCount: 0 })).toEqual({
      ok: true,
      mode: "text",
    });
    // 台词必须落在 <d> 标签内，否则执行器的时长推算拿不到内容。
    expect(prompt).toContain("<d>[Chinese] 你好亲爱的</d>");
    // 开场 1 秒无人声，第一句挂 00:01.000。
    expect(prompt).toContain("[Shot 1] 画面开始的一秒内");
    expect(prompt).toContain("At 00:01.000");
  });

  it("带参考音时组装成六段式并以 @1 引用音色", () => {
    const prompt = buildH3AudioPromptFromDialogue({
      text: "你好亲爱的",
      referenceAudioCount: 1,
    });

    expect(validateH3AudioPromptContract({ prompt, referenceAudioCount: 1 })).toEqual({
      ok: true,
      mode: "reference",
    });
    expect(prompt).toContain("subject_definitions:");
    expect(prompt).toContain("retention_analysis:");
    // 执行器用 replaceNumberedReferenceAliases 把 @1 换成 <Audio 1>。
    expect(prompt).toContain("@1");
  });

  it("已满足合同的提示词原样透传，不被模板覆盖", () => {
    const structured = "integrated_multimodal_description: x\noverall_soundscape: N/A\nnon_diegetic_music: N/A";
    expect(resolveH3AudioPrompt({ prompt: structured, referenceAudioCount: 0 })).toEqual({
      prompt: structured,
      source: "structured",
    });
  });

  it("普通台词标记为简易模式来源", () => {
    const resolved = resolveH3AudioPrompt({ prompt: "你好亲爱的", referenceAudioCount: 0 });
    expect(resolved.source).toBe("plain_text");
    expect(resolved.prompt).toContain("<d>[Chinese] 你好亲爱的</d>");
  });

  it("逐行拆句，空行与首尾空白不计入台词", () => {
    expect(splitDialogueLines("  第一句  \n\n   \n第二句\n")).toEqual(["第一句", "第二句"]);
  });

  it("多句台词时间戳严格递增，且每句都有独立镜头", () => {
    const shots = planH3DialogueShots(["第一句话", "第二句话更长一些"]);

    expect(shots).toHaveLength(2);
    expect(shots[0]!.timestamp).toBe("00:01.000");
    expect(shots[1]!.startSeconds).toBeGreaterThan(shots[0]!.startSeconds);
    expect(planH3DialogueDuration(shots)).toBeGreaterThan(shots[1]!.startSeconds);
  });

  it("纯英文台词标注 English，中文台词标注 Chinese", () => {
    expect(planH3DialogueShots(["Hello there friend"])[0]!.languageTag).toBe("English");
    expect(planH3DialogueShots(["你好亲爱的"])[0]!.languageTag).toBe("Chinese");
  });

  it("空台词显式失败，不产出空提示词", () => {
    expect(() => buildH3AudioPromptFromDialogue({ text: "   \n  ", referenceAudioCount: 0 }))
      .toThrowError("H3 音频简易模式需要非空台词文本");
  });

  it("常见三行台词仍落在执行器 1~15 秒可执行区间内", () => {
    const shots = planH3DialogueShots([
      "明天我就要去北京了，你有什么想要的吗？",
      "什么都不要了，你不用总想着我。",
      "那我给你带点特产回来吧。",
    ]);
    const duration = planH3DialogueDuration(shots);
    expect(duration).toBeGreaterThanOrEqual(1);
    expect(duration).toBeLessThanOrEqual(15);
  });
});
