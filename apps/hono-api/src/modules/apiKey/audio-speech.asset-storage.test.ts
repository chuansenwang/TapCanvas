import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedResolveObjectStorageConfig, mockedResolveLocalAssetStorageConfig } = vi.hoisted(() => ({
  mockedResolveObjectStorageConfig: vi.fn(),
  mockedResolveLocalAssetStorageConfig: vi.fn(),
}));

vi.mock("../asset/rustfs.client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../asset/rustfs.client")>()),
  resolveObjectStorageConfig: mockedResolveObjectStorageConfig,
}));

vi.mock("../asset/local-asset-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../asset/local-asset-storage")>()),
  resolveLocalAssetStorageConfig: mockedResolveLocalAssetStorageConfig,
}));

import { resolveAudioAssetStorage } from "./audio-speech";

const env = {} as never;

describe("音频资产存储解析", () => {
  beforeEach(() => {
    mockedResolveObjectStorageConfig.mockReset();
    mockedResolveLocalAssetStorageConfig.mockReset();
  });

  it("未配置对象存储时回退到本机 local 资产目录，而不是直接失败", () => {
    // 回归：本机以 LOCAL_ASSET_STORAGE_DIR 运行 local 资产模式时，
    // 音频路径曾硬依赖对象存储并抛 "Object storage is not configured"（用户看到的 500/502）。
    const localStorage = { kind: "local" as const, rootDirectory: "F:/tmp/assets/public" };
    mockedResolveObjectStorageConfig.mockReturnValue(null);
    mockedResolveLocalAssetStorageConfig.mockReturnValue(localStorage);

    expect(resolveAudioAssetStorage(env)).toEqual({
      objectStorage: null,
      localStorage,
    });
  });

  it("对象存储可用时优先使用对象存储，不回退本机目录", () => {
    const objectStorage = { bucket: "tapcanvas", publicBase: "https://assets.example.test" } as never;
    mockedResolveObjectStorageConfig.mockReturnValue(objectStorage);
    mockedResolveLocalAssetStorageConfig.mockReturnValue({ kind: "local", rootDirectory: "ignored" });

    expect(resolveAudioAssetStorage(env)).toEqual({
      objectStorage,
      localStorage: null,
    });
  });

  it("两种存储都不可用时显式失败，不静默丢弃音频", () => {
    mockedResolveObjectStorageConfig.mockReturnValue(null);
    mockedResolveLocalAssetStorageConfig.mockReturnValue(null);

    expect(() => resolveAudioAssetStorage(env)).toThrowError(
      expect.objectContaining({ code: "audio_asset_storage_unavailable" }),
    );
  });
});
