import { afterEach, describe, expect, it, vi } from "vitest";

import { h3DeliveryAudioFilter } from "./audio-speech";
import { generateMiniMaxH3AudioWithComfy } from "./minimax-h3-comfy";

type FetchMockArgs = [input: RequestInfo | URL, init?: RequestInit];

describe("MiniMax H3 直连 ComfyUI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("交付音频移除首秒预卷和其后的起始静音，保留 200ms 前导且不裁尾", () => {
    expect(h3DeliveryAudioFilter()).toBe(
      "atrim=start=1,asetpts=PTS-STARTPTS,silenceremove=start_periods=1:start_duration=0.20:start_threshold=-45dB:start_silence=0.08,adelay=200:all=1",
    );
  });

  it("通过 8188 上传参考音、提交 H3 节点图、轮询历史并下载音频", async () => {
    const fetchMock = vi.fn<FetchMockArgs, Promise<Response>>();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        UNETLoader: { input: { required: { unet_name: [["minimax_h3_fl2va_pruned_int8_convrot.safetensors"]] } } },
        CLIPLoader: { input: { required: { clip_name: [["qwen3vl_32b_minimax_h3_int8_convrot.safetensors"]] } } },
        VAELoader: { input: { required: { vae_name: [["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]] } } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(129).fill(1), { status: 200, headers: { "content-type": "audio/wav" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "tapcanvas-h3-ref.wav" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: "prompt-8188" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        "prompt-8188": {
          status: { status_str: "success" },
          outputs: { "41": { audio: [{ filename: "audio.flac", subfolder: "", type: "temp" }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(129).fill(1), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateMiniMaxH3AudioWithComfy({
      baseUrl: "http://127.0.0.1:8188",
      prompt: "subject_definitions: x\nsummary: x\nretention_analysis: x\ndetailed_description: <d>[English] Hello.</d> @1\noverall_soundscape: N/A\nnon_diegetic_music: N/A",
      referenceAudioUrls: ["https://assets.example.test/reference.wav"],
    });

    expect(result.promptId).toBe("prompt-8188");
    // 时长不来自用户输入：按 `<d>` 台词字符数（中文约 4.5 字/秒）加开场与收尾空间推导。
    // 该 prompt 的对白是 "Hello." 共 6 个非空白字符 → 6/4.5 ≈ 1.33s，加 1s 开场与 1.5s 收尾 = 3.83s。
    expect(result.selectedDuration).toBeCloseTo(3.83, 2);
    expect(result.audio.byteLength).toBeGreaterThan(128);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://127.0.0.1:8188/object_info");
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://assets.example.test/reference.wav");
    expect(String(fetchMock.mock.calls[2]![0])).toBe("http://127.0.0.1:8188/upload/image");
    expect(String(fetchMock.mock.calls[3]![0])).toBe("http://127.0.0.1:8188/prompt");
    expect(String(fetchMock.mock.calls[4]![0])).toBe("http://127.0.0.1:8188/history/prompt-8188");
    expect(String(fetchMock.mock.calls[5]![0])).toContain("http://127.0.0.1:8188/view?filename=audio.flac");

    const request = fetchMock.mock.calls[3]![1];
    expect(request?.method).toBe("POST");
    const payload: unknown = JSON.parse(String(request?.body));
    expect(payload).toMatchObject({ client_id: expect.stringMatching(/^tapcanvas-h3-/u) });
    const workflow = (payload as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    const nodes = Object.values(workflow);
    const unet = nodes.find((node) => node.class_type === "UNETLoader");
    const loader = nodes.find((node) => node.class_type === "LoadAudio");
    const conditioning = nodes.find((node) => node.class_type === "MiniMaxH3ReferenceToVideo");
    const scheduler = nodes.find((node) => node.class_type === "BasicScheduler");
    expect(unet?.inputs.unet_name).toBe("minimax_h3_fl2va_pruned_int8_convrot.safetensors");
    expect(loader?.inputs.audio).toBe("tapcanvas-h3-ref.wav");
    expect(conditioning?.inputs.prompt).toMatchObject([expect.any(String), 0]);
    // 采样步数取工作流固定配置，不接受调用方覆盖。
    expect(scheduler?.inputs.steps).toBe(10);
  });

  it("8188 未枚举 H3 必需模型时显式失败，不静默替换模型", async () => {
    const fetchMock = vi.fn<FetchMockArgs, Promise<Response>>();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      UNETLoader: { input: { required: { unet_name: [["some_other_model.safetensors"]] } } },
      CLIPLoader: { input: { required: { clip_name: [["qwen3vl_32b_minimax_h3_int8_convrot.safetensors"]] } } },
      VAELoader: { input: { required: { vae_name: [["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]] } } },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateMiniMaxH3AudioWithComfy({
      baseUrl: "http://127.0.0.1:8188",
      prompt: "integrated_multimodal_description: x\noverall_soundscape: N/A\nnon_diegetic_music: N/A",
      referenceAudioUrls: [],
    })).rejects.toMatchObject({ code: "minimax_h3_model_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("按台词估算超过 15 秒时显式拒绝，不截断台词", async () => {
    const longLine = "这是一句需要用更长时间才能念完的台词，用来验证估算超出上限时的显式失败。".repeat(4);
    await expect(generateMiniMaxH3AudioWithComfy({
      baseUrl: "http://127.0.0.1:8188",
      prompt: `integrated_multimodal_description: <d>[Chinese] ${longLine}</d>\noverall_soundscape: N/A\nnon_diegetic_music: N/A`,
      referenceAudioUrls: [],
    })).rejects.toMatchObject({ code: "minimax_h3_audio_duration_unexecutable" });
  });

  it("生成失败时暴露 ComfyUI 的真实异常原因，而不是 undefined", async () => {
    // 回归：此前误读 history.messages（顶层不存在），真实原因在
    // history.status.messages 的 execution_error 事件里，导致用户只看到「生成失败：undefined」。
    const fetchMock = vi.fn<FetchMockArgs, Promise<Response>>();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        UNETLoader: { input: { required: { unet_name: [["minimax_h3_fl2va_pruned_int8_convrot.safetensors"]] } } },
        CLIPLoader: { input: { required: { clip_name: [["qwen3vl_32b_minimax_h3_int8_convrot.safetensors"]] } } },
        VAELoader: { input: { required: { vae_name: [["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"]] } } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: "prompt-boom" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        "prompt-boom": {
          status: {
            status_str: "error",
            completed: false,
            messages: [["execution_error", {
              node_type: "SamplerCustomAdvanced",
              exception_type: "RuntimeError",
              exception_message: "Expected all tensors to be on the same device, but found at least two devices, cuda:0 and cpu!",
            }]],
          },
          outputs: {},
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const failure = generateMiniMaxH3AudioWithComfy({
      baseUrl: "http://127.0.0.1:8188",
      prompt: "integrated_multimodal_description: x\noverall_soundscape: N/A\nnon_diegetic_music: N/A",
      referenceAudioUrls: [],
    });
    await expect(failure).rejects.toMatchObject({
      code: "minimax_h3_generation_failed",
      message: expect.stringContaining("SamplerCustomAdvanced"),
    });
    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining("Expected all tensors to be on the same device"),
    });
    await expect(failure).rejects.not.toThrowError(/undefined/u);
  });
});
