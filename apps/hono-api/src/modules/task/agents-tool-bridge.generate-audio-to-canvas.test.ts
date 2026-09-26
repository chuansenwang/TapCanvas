import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContext } from "../../types";
import type { FlowRow } from "../flow/flow.repo";

const {
  mockedSynthesizeSpeechToStorage,
  mockedRequireSelectableAudioModel,
  mockedPersistFlowPatch,
  mockedRegisterGeneratedMediaAsset,
  mockedIsDoubaoSpeechCatalogModel,
  mockedIsMiniMaxH3SpeechModel,
  mockedValidateAudioRuntimeParameters,
  mockedSynthesizeDoubaoSpeechToStorage,
  mockedSynthesizeMiniMaxH3SpeechToStorage,
  mockedListDoubaoSeedAudioVoices,
  mockedRunComfyUiTask,
  mockedRequireDefaultMiniMaxH3SpeechModel,
  mockedReadFlowNodes,
} = vi.hoisted(() => ({
  mockedSynthesizeSpeechToStorage: vi.fn(),
  mockedRequireSelectableAudioModel: vi.fn(),
  mockedPersistFlowPatch: vi.fn(),
  mockedRegisterGeneratedMediaAsset: vi.fn(),
  mockedIsDoubaoSpeechCatalogModel: vi.fn(),
  mockedIsMiniMaxH3SpeechModel: vi.fn(() => false),
  mockedValidateAudioRuntimeParameters: vi.fn(() => ({})),
  mockedSynthesizeDoubaoSpeechToStorage: vi.fn(),
  mockedSynthesizeMiniMaxH3SpeechToStorage: vi.fn(),
  mockedListDoubaoSeedAudioVoices: vi.fn(),
  mockedRunComfyUiTask: vi.fn(),
  mockedRequireDefaultMiniMaxH3SpeechModel: vi.fn(),
  mockedReadFlowNodes: vi.fn((): Array<Record<string, unknown>> => []),
}));

vi.mock("../apiKey/audio-speech", () => ({
  synthesizeSpeechToStorage: mockedSynthesizeSpeechToStorage,
  synthesizeDoubaoSpeechToStorage: mockedSynthesizeDoubaoSpeechToStorage,
  isDoubaoSpeechCatalogModel: mockedIsDoubaoSpeechCatalogModel,
  isMiniMaxH3SpeechModel: mockedIsMiniMaxH3SpeechModel,
  synthesizeMiniMaxH3SpeechToStorage: mockedSynthesizeMiniMaxH3SpeechToStorage,
  generateMusicToStorage: vi.fn(),
}));

vi.mock("../new-api-models/new-api-audio-model", () => ({
  requireSelectableAudioModel: mockedRequireSelectableAudioModel,
  requireDefaultMiniMaxH3SpeechModel: mockedRequireDefaultMiniMaxH3SpeechModel,
  validateAudioRuntimeParameters: mockedValidateAudioRuntimeParameters,
}));

vi.mock("../apiKey/seed-audio-voices", () => ({
  listDoubaoSeedAudioVoices: mockedListDoubaoSeedAudioVoices,
}));

vi.mock("./video-orchestrator.flow-io", () => ({
  persistFlowPatch: mockedPersistFlowPatch,
  readFlowNodes: mockedReadFlowNodes,
}));

vi.mock("../asset/asset.hosting", () => ({
  registerGeneratedMediaAsset: mockedRegisterGeneratedMediaAsset,
}));

vi.mock("./material-auto-register", () => ({
  maybeAutoRegisterVoiceCard: vi.fn(),
}));

vi.mock("./comfyui-workflow", () => ({
  runComfyUiTask: mockedRunComfyUiTask,
}));

import { generateAudioToCanvas } from "./agents-tool-bridge.generate-audio-to-canvas";

function audioRow(id: string, data?: string): FlowRow {
  return {
    id,
    name: "Audio flow",
    data: data ?? JSON.stringify({ nodes: [], edges: [] }),
    owner_id: "user-1",
    project_id: "project-1",
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
  };
}

describe("generateAudioToCanvas asset contract", () => {
  beforeEach(() => {
    mockedSynthesizeSpeechToStorage.mockReset();
    mockedRequireSelectableAudioModel.mockReset();
    mockedPersistFlowPatch.mockReset();
    mockedRegisterGeneratedMediaAsset.mockReset();
    mockedIsDoubaoSpeechCatalogModel.mockReset();
		mockedIsMiniMaxH3SpeechModel.mockReset();
    mockedValidateAudioRuntimeParameters.mockReset();
    mockedSynthesizeDoubaoSpeechToStorage.mockReset();
		mockedSynthesizeMiniMaxH3SpeechToStorage.mockReset();
    mockedListDoubaoSeedAudioVoices.mockReset();
		mockedRunComfyUiTask.mockReset();
		mockedIsDoubaoSpeechCatalogModel.mockReturnValue(false);
		mockedIsMiniMaxH3SpeechModel.mockReturnValue(false);
		mockedValidateAudioRuntimeParameters.mockReturnValue({});
    mockedListDoubaoSeedAudioVoices.mockResolvedValue([]);
    mockedRequireDefaultMiniMaxH3SpeechModel.mockReset();
    mockedRequireDefaultMiniMaxH3SpeechModel.mockResolvedValue({
      requestModelKey: "minimax-h3-speech",
      tags: ["tapcanvas:audio-type=speech", "tapcanvas:audio-engine=minimax-h3"],
    });
    mockedReadFlowNodes.mockReset();
    mockedReadFlowNodes.mockReturnValue([]);
    mockedRequireSelectableAudioModel.mockResolvedValue({
      requestModelKey: "speech-model-1",
      tags: ["tapcanvas:audio-type=speech", "tapcanvas:audio-engine=minimax"],
    });
    mockedSynthesizeSpeechToStorage.mockResolvedValue({
      url: "https://assets.example.com/voice.mp3",
      durationSec: 4.5,
      voiceId: "voice-1",
    });
    mockedRegisterGeneratedMediaAsset.mockResolvedValue("asset-audio-1");
    mockedPersistFlowPatch.mockResolvedValue(undefined);
  });

	it("routes a selected local ComfyUI audio model to its workflow instead of new-api", async () => {
		const row: FlowRow = {
			id: "flow-comfy-audio",
			name: "Local audio flow",
			data: JSON.stringify({ nodes: [], edges: [] }),
			owner_id: "user-1",
			project_id: "project-1",
			created_at: "2026-08-23T00:00:00.000Z",
			updated_at: "2026-08-23T00:00:00.000Z",
		};
		mockedRequireSelectableAudioModel.mockResolvedValue({
			requestModelKey: "indextts-2.5",
			tags: ["tapcanvas:audio-type=speech", "tapcanvas:audio-engine=comfyui"],
		});
		mockedRunComfyUiTask.mockResolvedValue({
			assets: [{ type: "audio", url: "http://127.0.0.1:8188/view?filename=voice.wav" }],
		});

		await generateAudioToCanvas({
			c: { env: { DB: {} } } as AppContext,
			requestUserId: "user-1",
			devBypass: false,
			flowId: row.id,
			row,
			bodyArgs: {
				node: { id: "audio-comfy", data: { audioType: "speech", audioModel: "indextts-2.5", text: "本地合成" } },
			},
		});

		expect(mockedRunComfyUiTask).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
			kind: "text_to_audio",
			prompt: "本地合成",
			extras: expect.objectContaining({ modelKey: "indextts-2.5" }),
		}));
		expect(mockedSynthesizeSpeechToStorage).not.toHaveBeenCalled();
	});

	it("routes minmax-h3-audio to the dedicated local ComfyUI executor instead of new-api", async () => {
		const row: FlowRow = {
			id: "flow-h3-audio",
			name: "H3 audio flow",
			data: JSON.stringify({ nodes: [], edges: [] }),
			owner_id: "user-1",
			project_id: "project-1",
			created_at: "2026-08-23T00:00:00.000Z",
			updated_at: "2026-08-23T00:00:00.000Z",
		};
		mockedRequireSelectableAudioModel.mockResolvedValue({
			requestModelKey: "minmax-h3-audio",
			tags: ["tapcanvas:audio-type=speech", "tapcanvas:audio-engine=minimax-h3"],
		});
		mockedIsMiniMaxH3SpeechModel.mockReturnValue(true);
		mockedSynthesizeMiniMaxH3SpeechToStorage.mockResolvedValue({
			url: "https://assets.example.com/h3.wav",
			sourceUrl: "https://assets.example.com/h3.source.flac",
			durationSec: 5,
			sourceDurationSec: 6,
			voiceId: "",
		});

		await generateAudioToCanvas({
			c: { env: { DB: {} } } as AppContext,
			requestUserId: "user-1",
			devBypass: false,
			flowId: row.id,
			row,
			bodyArgs: {
				node: { id: "audio-h3", data: { audioType: "speech", audioModel: "minmax-h3-audio", text: "本地 H3 音频" } },
			},
		});

		expect(mockedSynthesizeMiniMaxH3SpeechToStorage).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			expect.objectContaining({ model: "minmax-h3-audio", prompt: "本地 H3 音频" }),
		);
		expect(mockedSynthesizeSpeechToStorage).not.toHaveBeenCalled();
		expect(mockedRunComfyUiTask).not.toHaveBeenCalled();
	});

  it("registers generated audio and writes the same asset id to the canvas node", async () => {
    const row: FlowRow = {
      id: "flow-1",
      name: "Audio flow",
      data: JSON.stringify({ nodes: [], edges: [] }),
      owner_id: "user-1",
      project_id: "project-1",
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    };

    const result = await generateAudioToCanvas({
      c: { env: { DB: {} } } as AppContext,
      requestUserId: "user-1",
      devBypass: false,
      flowId: row.id,
      row,
      bodyArgs: {
        node: {
          id: "audio-node-1",
          data: {
            audioType: "speech",
            text: "你好，世界",
            label: "旁白",
          },
        },
      },
    });

    expect(mockedRegisterGeneratedMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      meta: expect.objectContaining({
        type: "audio",
        url: "https://assets.example.com/voice.mp3",
        durationSec: 4.5,
        generationContext: expect.objectContaining({
          projectId: "project-1",
          flowId: "flow-1",
          nodeId: "audio-node-1",
        }),
      }),
    }));
    expect(mockedPersistFlowPatch).toHaveBeenCalledWith(expect.objectContaining({
      patch: {
        createNodes: [
          expect.objectContaining({
            id: "audio-node-1",
            data: expect.objectContaining({
              audioUrl: "https://assets.example.com/voice.mp3",
              assetId: "asset-audio-1",
              serverAssetId: "asset-audio-1",
              assetRegistrationStatus: "ready",
              audioResults: [
                expect.objectContaining({
                  url: "https://assets.example.com/voice.mp3",
                  assetId: "asset-audio-1",
                }),
              ],
            }),
          }),
        ],
      },
    }));
    expect(result).toMatchObject({
      ok: true,
      nodeId: "audio-node-1",
      assetId: "asset-audio-1",
      audioUrl: "https://assets.example.com/voice.mp3",
    });
  });

  it("preserves produced audio on the canvas and reports partial success when asset registration fails", async () => {
    const row: FlowRow = {
      id: "flow-2",
      name: "Audio flow",
      data: JSON.stringify({ nodes: [], edges: [] }),
      owner_id: "user-1",
      project_id: "project-1",
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    };
    mockedRegisterGeneratedMediaAsset.mockRejectedValueOnce(new Error("asset database unavailable"));

    await expect(generateAudioToCanvas({
      c: { env: { DB: {} } } as AppContext,
      requestUserId: "user-1",
      devBypass: false,
      flowId: row.id,
      row,
      bodyArgs: {
        node: {
          id: "audio-node-partial",
          data: { audioType: "speech", text: "保留这段音频" },
        },
      },
    })).rejects.toMatchObject({ code: "audio_asset_registration_partial_success" });

    expect(mockedPersistFlowPatch).toHaveBeenCalledWith(expect.objectContaining({
      patch: {
        createNodes: [
          expect.objectContaining({
            id: "audio-node-partial",
            data: expect.objectContaining({
              status: "success",
              audioUrl: "https://assets.example.com/voice.mp3",
              assetRegistrationStatus: "failed",
              assetRegistrationError: "asset database unavailable",
            }),
          }),
        ],
      },
    }));
  });

  it("refuses an unavailable frozen voice id before starting paid synthesis", async () => {
    const row: FlowRow = {
      id: "flow-exact-voice",
      name: "Voice workflow",
      data: JSON.stringify({ nodes: [], edges: [] }),
      owner_id: "user-1",
      project_id: "project-1",
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    };
    mockedRequireSelectableAudioModel.mockResolvedValue({
      requestModelKey: "doubao-seed-audio-1-0",
      tags: ["tapcanvas:audio-type=speech", "tapcanvas:audio-engine=doubao"],
    });
    mockedIsDoubaoSpeechCatalogModel.mockReturnValue(true);
    mockedListDoubaoSeedAudioVoices.mockResolvedValue([
      { id: "voice-live", name: "实时音色" },
    ]);

    await expect(generateAudioToCanvas({
      c: { env: { DB: {} } } as AppContext,
      requestUserId: "user-1",
      devBypass: false,
      flowId: row.id,
      row,
      bodyArgs: {
        node: {
          id: "voice-card-1",
          data: {
            audioType: "voice_card",
            voiceCharacter: "角色甲",
            voiceId: "voice-frozen-but-removed",
            requireExactVoiceId: true,
            audioModel: "doubao-seed-audio-1-0",
          },
        },
      },
    })).rejects.toMatchObject({ code: "audio_voice_exact_id_unavailable" });

    expect(mockedSynthesizeDoubaoSpeechToStorage).not.toHaveBeenCalled();
    expect(mockedPersistFlowPatch).not.toHaveBeenCalled();
    expect(mockedRegisterGeneratedMediaAsset).not.toHaveBeenCalled();
  });

	it("resolves the catalog-declared MiniMax H3 speech default when audioModel is omitted", async () => {
		const row = audioRow("flow-default-h3");
		mockedIsMiniMaxH3SpeechModel.mockReturnValue(true);
		mockedSynthesizeMiniMaxH3SpeechToStorage.mockResolvedValue({
			url: "https://assets.example.com/h3-default.wav",
			sourceUrl: "https://assets.example.com/h3-default.source.flac",
			durationSec: 5,
			sourceDurationSec: 6,
			voiceId: "",
		} as never);

		await generateAudioToCanvas({
			c: { env: { DB: {} } } as AppContext,
			requestUserId: "user-1",
			devBypass: false,
			flowId: row.id,
			row,
			bodyArgs: { node: { id: "audio-default", data: { text: "默认 H3 配音" } } },
		});

		expect(mockedRequireDefaultMiniMaxH3SpeechModel).toHaveBeenCalledTimes(1);
		expect(mockedRequireSelectableAudioModel).toHaveBeenCalledWith(
			expect.anything(),
			"minimax-h3-speech",
			"speech",
		);
		expect(mockedSynthesizeMiniMaxH3SpeechToStorage).toHaveBeenCalledTimes(1);
		expect(mockedSynthesizeSpeechToStorage).not.toHaveBeenCalled();
	});

	it("fails explicitly instead of falling back when no MiniMax H3 speech model is declared", async () => {
		const row = audioRow("flow-default-missing");
		mockedRequireDefaultMiniMaxH3SpeechModel.mockRejectedValue(
			Object.assign(new Error("no default engine"), { code: "audio_default_model_unavailable" }),
		);

		await expect(generateAudioToCanvas({
			c: { env: { DB: {} } } as AppContext,
			requestUserId: "user-1",
			devBypass: false,
			flowId: row.id,
			row,
			bodyArgs: { node: { id: "audio-no-default", data: { text: "没有默认引擎" } } },
		})).rejects.toMatchObject({ code: "audio_default_model_unavailable" });

		expect(mockedSynthesizeSpeechToStorage).not.toHaveBeenCalled();
		expect(mockedSynthesizeDoubaoSpeechToStorage).not.toHaveBeenCalled();
		expect(mockedSynthesizeMiniMaxH3SpeechToStorage).not.toHaveBeenCalled();
		expect(mockedPersistFlowPatch).not.toHaveBeenCalled();
	});

	it("resolves reference audio from real canvas nodes and refuses nodes without a real audio asset", async () => {
		const row = audioRow("flow-reference-audio");
		mockedIsMiniMaxH3SpeechModel.mockReturnValue(true);
		mockedSynthesizeMiniMaxH3SpeechToStorage.mockResolvedValue({
			url: "https://assets.example.com/h3-ref.wav",
			sourceUrl: "https://assets.example.com/h3-ref.source.flac",
			durationSec: 5,
			sourceDurationSec: 6,
			voiceId: "",
		} as never);
		mockedReadFlowNodes.mockReturnValue([
			{ id: "voice-a", data: { kind: "audio", audioUrl: "https://assets.example.com/ref-a.mp3" } },
		]);

		await generateAudioToCanvas({
			c: { env: { DB: {} } } as AppContext,
			requestUserId: "user-1",
			devBypass: false,
			flowId: row.id,
			row,
			bodyArgs: {
				node: {
					id: "audio-ref",
					data: { text: "延续上一镜音色", referenceAudioNodeIds: ["voice-a"] },
				},
			},
		});

		expect(mockedSynthesizeMiniMaxH3SpeechToStorage).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			expect.objectContaining({
				referenceAudioUrls: ["https://assets.example.com/ref-a.mp3"],
			}),
		);

		mockedReadFlowNodes.mockReturnValue([{ id: "voice-b", data: { kind: "audio" } }]);
		await expect(generateAudioToCanvas({
			c: { env: { DB: {} } } as AppContext,
			requestUserId: "user-1",
			devBypass: false,
			flowId: row.id,
			row,
			bodyArgs: {
				node: { id: "audio-ref-missing", data: { text: "缺失参考", referenceAudioNodeIds: ["voice-b"] } },
			},
		})).rejects.toMatchObject({ code: "audio_reference_node_has_no_audio" });
	});

	it("refuses reference audio for music generation instead of ignoring the input", async () => {
		const row = audioRow("flow-music-reference");

		await expect(generateAudioToCanvas({
			c: { env: { DB: {} } } as AppContext,
			requestUserId: "user-1",
			devBypass: false,
			flowId: row.id,
			row,
			bodyArgs: {
				node: {
					id: "music-ref",
					data: { audioType: "music", text: "低沉氛围", referenceAudioNodeIds: ["voice-a"] },
				},
			},
		})).rejects.toMatchObject({ code: "audio_reference_not_supported_for_music" });

		expect(mockedReadFlowNodes).not.toHaveBeenCalled();
		expect(mockedPersistFlowPatch).not.toHaveBeenCalled();
	});
});
