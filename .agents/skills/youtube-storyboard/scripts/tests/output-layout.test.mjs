import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { STORYBOARD_DIR_SUFFIX, resolveStoryboardDir } from "../lib/output-layout.mjs";

test("本地视频的产物目录与视频同目录同名，并带 .storyboard 后缀", () => {
  const videoPath = path.join("E:", "视频下载", "Emma.mp4");
  assert.equal(
    resolveStoryboardDir({ videoPath }),
    path.join("E:", "视频下载", `Emma${STORYBOARD_DIR_SUFFIX}`),
  );
});

test("同一目录下不同视频解析出彼此独立的产物目录", () => {
  const root = path.join("E:", "视频下载");
  const first = resolveStoryboardDir({ videoPath: path.join(root, "Emma.mp4") });
  const second = resolveStoryboardDir({ videoPath: path.join(root, "Shopping.mp4") });
  assert.notEqual(first, second);
  // 关键约束：产物目录必须落在视频所在目录之下，而不是与视频文件平铺。
  assert.equal(path.dirname(first), root);
  assert.equal(path.dirname(second), root);
});

test("视频名里的多个点只剥掉最后的扩展名", () => {
  const videoPath = path.join("E:", "视频下载", "English at a City Festival.mp4");
  assert.equal(
    resolveStoryboardDir({ videoPath }),
    path.join("E:", "视频下载", `English at a City Festival${STORYBOARD_DIR_SUFFIX}`),
  );
});

test("显式 --out-dir 原样解析为绝对路径，不再拼接到视频目录", () => {
  const videoPath = path.join("E:", "视频下载", "Emma.mp4");
  const outDir = path.join("F:", "storyboards", "emma");
  assert.equal(resolveStoryboardDir({ videoPath, outDir }), path.resolve(outDir));
});

test("无法从视频路径解析文件名时显式失败，不猜一个默认目录", () => {
  assert.throws(() => resolveStoryboardDir({ videoPath: path.join("E:", ".mp4") }), /无法从视频路径解析文件名/);
});
