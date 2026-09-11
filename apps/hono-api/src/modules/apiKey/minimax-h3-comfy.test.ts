import { afterEach, describe, expect, it, vi } from "vitest";

import { h3DeliveryAudioFilter } from "./audio-speech";
import { generateMiniMaxH3AudioWithComfy } from "./minimax-h3-comfy";

type FetchMockArgs = [input: RequestInfo | URL, init?: RequestInit];

describe("MiniMax H3 直连 ComfyUI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("交付音频移除首秒预卷和其后的起始静音，保留 50ms 前导且不裁尾", () => {
    expect(h3DeliveryAudioFilter()).toBe(
      "atrim=start=1,asetpts=PTS-STARTPTS,silenceremove=start_periods=1:start_duration=0.20:start_threshold=-45dB:start_silence=0.08,adelay=50:all=1",
    );
  });

  it("通过 8188 上传参考音、提交 H3 节点图、轮询历史并下载音频", async () => {
    const fetchMock = vi.fn<FetchMockArgs, Promise<Response>>();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        UNETLoader: { input: { required: { unet_name: [["Minimax_H3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors"]] } } },
        CLIPLoader: { input: { required: { clip_name: [["qwen3vl_32b_minimax_h3_int4_convrot.safetensors"]] } } },
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
      duration: 5,
      steps: null,
      unet: "fl2va",
      referenceAudioUrls: ["https://assets.example.test/reference.wav"],
    });

    expect(result.promptId).toBe("prompt-8188");
    expect(result.selectedDuration).toBe(5);
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
    expect(unet?.inputs.unet_name).toBe("Minimax_H3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors");
    expect(loader?.inputs.audio).toBe("tapcanvas-h3-ref.wav");
    expect(conditioning?.inputs.prompt).toMatchObject([expect.any(String), 0]);
  });

  it("拒绝 8188 未枚举的 UNET，不静默替换模型", async () => {
    await expect(generateMiniMaxH3AudioWithComfy({
      baseUrl: "http://127.0.0.1:8188",
      prompt: "integrated_multimodal_description: x\noverall_soundscape: N/A\nnon_diegetic_music: N/A",
      duration: 5,
      steps: null,
      unet: "ref2va",
      referenceAudioUrls: [],
    })).rejects.toMatchObject({ code: "minimax_h3_unet_unavailable" });
  });
});
