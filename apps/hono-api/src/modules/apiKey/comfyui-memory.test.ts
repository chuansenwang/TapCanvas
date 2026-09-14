import { afterEach, describe, expect, it, vi } from "vitest";

import {
  releaseComfyVram,
  releaseComfyVramAfterRun,
  shouldFreeComfyVramAfterRun,
} from "./comfyui-memory";

type FetchMockArgs = [input: RequestInfo | URL, init?: RequestInit];

describe("ComfyUI 显存回收", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("未配置开关时默认回收显存", () => {
    // 回归：H3 在本机 16G 卡上执行后会常驻约 13~14GB，默认必须归还，否则整卡被占住。
    expect(shouldFreeComfyVramAfterRun({})).toBe(true);
    expect(shouldFreeComfyVramAfterRun({ MINIMAX_H3_FREE_VRAM_AFTER_RUN: "" })).toBe(true);
  });

  it("显式关闭时跳过回收，保留模型缓存换取速度", () => {
    for (const raw of ["0", "false", "FALSE", " no ", "off"]) {
      expect(shouldFreeComfyVramAfterRun({ MINIMAX_H3_FREE_VRAM_AFTER_RUN: raw })).toBe(false);
    }
    for (const raw of ["1", "true", "yes", "on"]) {
      expect(shouldFreeComfyVramAfterRun({ MINIMAX_H3_FREE_VRAM_AFTER_RUN: raw })).toBe(true);
    }
  });

  it("向 /free 提交卸载模型与释放显存", async () => {
    const fetchMock = vi.fn<FetchMockArgs, Promise<Response>>();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await releaseComfyVram("http://127.0.0.1:8188");

    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://127.0.0.1:8188/free");
    const request = fetchMock.mock.calls[0]![1];
    expect(request?.method).toBe("POST");
    expect(JSON.parse(String(request?.body))).toEqual({ unload_models: true, free_memory: true });
  });

  it("baseUrl 末尾带斜杠时不产生双斜杠", async () => {
    const fetchMock = vi.fn<FetchMockArgs, Promise<Response>>();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await releaseComfyVram("http://127.0.0.1:8188/");

    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://127.0.0.1:8188/free");
  });

  it("回收失败时不覆盖主流程结果，但返回未回收", async () => {
    const fetchMock = vi.fn<FetchMockArgs, Promise<Response>>();
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(releaseComfyVram("http://127.0.0.1:8188")).rejects.toMatchObject({
        code: "comfyui_free_request_failed",
      });
      await expect(releaseComfyVramAfterRun({}, "http://127.0.0.1:8188")).resolves.toBe(false);
      // 清理步骤失败必须留痕，不允许静默跳过。
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("关闭开关时不发起任何请求", async () => {
    const fetchMock = vi.fn<FetchMockArgs, Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      releaseComfyVramAfterRun({ MINIMAX_H3_FREE_VRAM_AFTER_RUN: "0" }, "http://127.0.0.1:8188"),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
