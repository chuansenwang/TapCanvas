import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePythonCommand, runSubtitleTranscribe } from "../lib/subtitle-bridge.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-bridge-"));
}

test("resolvePythonCommand prefers configured interpreter and rejects missing path", () => {
  const exists = (value) => value === "C:\\custom\\python.exe";
  assert.deepEqual(
    resolvePythonCommand({ env: { AIGC_PYTHON: "C:\\custom\\python.exe" }, existsSync: exists, which: () => true }),
    ["C:\\custom\\python.exe"],
  );
  assert.throws(
    () => resolvePythonCommand({ env: { AIGC_PYTHON: "C:\\missing\\python.exe" }, existsSync: exists, which: () => true }),
    /AIGC_PYTHON 指向的解释器不存在/,
  );
});

test("resolvePythonCommand falls back to uv then venv then python", () => {
  assert.deepEqual(
    resolvePythonCommand({ env: {}, existsSync: () => true, which: (command) => command === "uv" }),
    ["uv", "run", "python"],
  );
  assert.deepEqual(
    resolvePythonCommand({
      env: {},
      existsSync: (value) => value.includes(".venv"),
      which: (command) => command !== "uv",
    }),
    [String.raw`F:\aigc\aigc\.venv\Scripts\python.exe`],
  );
  assert.deepEqual(
    resolvePythonCommand({ env: {}, existsSync: () => false, which: (command) => command === "python" }),
    ["python"],
  );
  assert.throws(
    () => resolvePythonCommand({ env: {}, existsSync: () => false, which: () => false }),
    /未找到可用的 Python 解释器/,
  );
});

test("runSubtitleTranscribe rejects unsupported mode before spawning", () => {
  assert.throws(
    () =>
      runSubtitleTranscribe({
        skillsRoot: process.cwd(),
        videoPath: "video.mp4",
        videoId: "video",
        outputDir: "out",
        mode: "auto-invalid",
      }),
    /字幕识别模式只支持/,
  );
});

test("runSubtitleTranscribe surfaces the skill failure instead of an empty result", () => {
  const root = makeTempDir();
  const skillsRoot = path.join(root, "skills");
  const scriptDir = path.join(skillsRoot, "subtitle-transcribe", "scripts");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(scriptDir, "transcribe_subtitles.py"), "# stub\n");
  const videoPath = path.join(root, "video.mp4");
  fs.writeFileSync(videoPath, "stub");
  const fakeSpawn = () => ({
    status: 1,
    stdout: '{"status":"failed","error":"YouTube 没有可用字幕"}',
    stderr: "字幕识别失败：YouTube 没有可用字幕",
  });
  assert.throws(
    () =>
      runSubtitleTranscribe({
        skillsRoot,
        videoPath,
        videoId: "video",
        outputDir: root,
        mode: "youtube",
        spawn: fakeSpawn,
      }),
    /YouTube 没有可用字幕/,
  );
});

test("runSubtitleTranscribe returns the segments fact file content", () => {
  const root = makeTempDir();
  const workDir = makeTempDir();
  const videoPath = path.join(workDir, "video.mp4");
  fs.writeFileSync(videoPath, "stub");
  const skillsRoot = path.join(root, "skills");
  const skillRoot = path.join(skillsRoot, "subtitle-transcribe", "scripts");
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "transcribe_subtitles.py"), "# stub\n");

  let received = null;
  const fakeSpawn = (command, args) => {
    received = { command, args };
    const outDirIndex = args.indexOf("--out-dir");
    const outDir = args[outDirIndex + 1];
    fs.mkdirSync(outDir, { recursive: true });
    const segmentsPath = path.join(outDir, "video_transcript_segments.json");
    fs.writeFileSync(
      segmentsPath,
      JSON.stringify({
        schemaVersion: "subtitle-transcribe/v1",
        durationSec: 12.5,
        segments: [{ start: 0, end: 12.5, text: "hello" }],
      }),
    );
    return {
      status: 0,
      stdout: JSON.stringify({
        status: "ok",
        source: "whisper",
        captionKind: null,
        speakerLabelling: { enabled: false, source: null, speaker_count: 0 },
        segmentCount: 1,
        artifacts: { segments: segmentsPath },
        report: path.join(outDir, "subtitle-recognition-report.json"),
      }),
      stderr: "",
    };
  };

  const result = runSubtitleTranscribe({
    skillsRoot,
    videoPath,
    videoId: "video",
    outputDir: path.join(workDir, "out"),
    mode: "auto",
    spawn: fakeSpawn,
  });
  assert.equal(received.args.at(-2), "--mode");
  assert.equal(received.args.at(-1), "auto");
  assert.equal(result.sourceKind, "whisper");
  assert.equal(result.segmentCount, 1);
  assert.equal(result.durationSec, 12.5);
  assert.deepEqual(result.segments, [{ start: 0, end: 12.5, text: "hello" }]);
});
