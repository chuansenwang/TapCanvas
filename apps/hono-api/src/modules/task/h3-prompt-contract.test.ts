import { describe, expect, it } from "vitest";
import { validateH3AudioPromptContract, validateH3PromptContract } from "./h3-prompt-contract";

describe("MiniMax H3 提示词合同", () => {
  it("要求文生模式的三个核心段落", () => {
    const result = validateH3PromptContract({
      prompt: "integrated_multimodal_description: x\noverall_soundscape: N/A\nnon_diegetic_music: N/A",
      mediaInputs: [],
    });
    expect(result).toEqual({ ok: true, mode: "text" });
  });

  it("要求全参考模式的六段结构", () => {
    const result = validateH3PromptContract({
      prompt: "subject_definitions: x\nsummary: x\nretention_analysis: x\ndetailed_description: x\noverall_soundscape: x\nnon_diegetic_music: N/A",
      mediaInputs: [{ type: "image", url: "https://example.test/a.png", role: "reference" }],
    });
    expect(result).toEqual({ ok: true, mode: "reference" });
  });

  it("返回缺少字段而不是静默补写", () => {
    const result = validateH3PromptContract({ prompt: "故事段落", mediaInputs: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual([
        "integrated_multimodal_description",
        "overall_soundscape",
        "non_diegetic_music",
      ]);
    }
  });
});

describe("MiniMax H3 音频提示词合同", () => {
  it("无参考音时要求基础三段结构", () => {
    expect(validateH3AudioPromptContract({
      prompt: "integrated_multimodal_description: x\noverall_soundscape: N/A\nnon_diegetic_music: N/A",
      referenceAudioCount: 0,
    })).toEqual({ ok: true, mode: "text" });
  });

  it("有参考音时要求六段 Ref2VA 结构", () => {
    expect(validateH3AudioPromptContract({
      prompt: "subject_definitions: x\nsummary: x\nretention_analysis: x\ndetailed_description: x\noverall_soundscape: x\nnon_diegetic_music: N/A",
      referenceAudioCount: 1,
    })).toEqual({ ok: true, mode: "reference" });
  });

  it("不把语言标签限制为中文", () => {
    expect(validateH3AudioPromptContract({
      prompt: "integrated_multimodal_description: <d>[English] Hello.</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A",
      referenceAudioCount: 0,
    })).toEqual({ ok: true, mode: "text" });
  });
});
