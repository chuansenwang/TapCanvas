import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MIN_CUT_GAP_SEC,
  DEFAULT_SCENE_THRESHOLD,
  buildShots,
  dedupeCuts,
  parseSceneLog,
} from "../lib/shot-detection.mjs";

test("parseSceneLog pairs each pts_time with the scene score on the next line", () => {
  const log = [
    "frame:0    pts:162816  pts_time:10.6",
    "lavfi.scene_score=0.361871",
    "frame:1    pts:2354688 pts_time:153.3",
    "lavfi.scene_score=0.298123",
  ].join("\n");
  assert.deepEqual(parseSceneLog(log), [
    { timeSec: 10.6, score: 0.361871 },
    { timeSec: 153.3, score: 0.298123 },
  ]);
});

test("parseSceneLog reports a missing score as null instead of inventing one", () => {
  const log = "frame:0    pts:512     pts_time:5.266667\n";
  assert.deepEqual(parseSceneLog(log), [{ timeSec: 5.266667, score: null }]);
});

test("parseSceneLog returns nothing for an empty log", () => {
  assert.deepEqual(parseSceneLog(""), []);
  assert.deepEqual(parseSceneLog(null), []);
});

test("dedupeCuts keeps only the first cut of each burst", () => {
  // 实测：一次真实切换会被连报两帧，间隔 0.033 秒。
  const cuts = [
    { timeSec: 10.6, score: 0.3 },
    { timeSec: 10.633, score: 0.3 },
    { timeSec: 20.0, score: 0.4 },
    { timeSec: 20.033, score: 0.4 },
  ];
  assert.deepEqual(dedupeCuts(cuts), [
    { timeSec: 10.6, score: 0.3 },
    { timeSec: 20.0, score: 0.4 },
  ]);
});

test("dedupeCuts does not merge genuinely separate shots", () => {
  const cuts = [
    { timeSec: 0, score: null },
    { timeSec: 5, score: 0.5 },
    { timeSec: 9, score: 0.4 },
  ];
  assert.equal(dedupeCuts(cuts).length, 3);
});

test("dedupeCuts respects a custom gap", () => {
  const cuts = [
    { timeSec: 0, score: null },
    { timeSec: 0.5, score: null },
    { timeSec: 2, score: null },
  ];
  assert.equal(dedupeCuts(cuts, 1).length, 2);
});

test("buildShots covers the whole video with no gaps or overlaps", () => {
  const cuts = [
    { timeSec: 10, score: 0.3 },
    { timeSec: 25, score: 0.4 },
  ];
  const shots = buildShots({ cuts, durationSec: 60, frameRate: 30 });
  assert.equal(shots.length, 3);
  assert.equal(shots[0].startSec, 0);
  assert.equal(shots.at(-1).endSec, 60);
  for (let index = 1; index < shots.length; index += 1) {
    assert.equal(shots[index].startSec, shots[index - 1].endSec);
  }
  assert.deepEqual(
    shots.map((shot) => shot.shotIndex),
    [1, 2, 3],
  );
});

test("buildShots samples the midpoint and derives a frame number from real frame rate", () => {
  const shots = buildShots({ cuts: [], durationSec: 10, frameRate: 30 });
  assert.equal(shots.length, 1);
  assert.equal(shots[0].sampleTimeSec, 5);
  assert.equal(shots[0].frameNumber, 150);
});

test("buildShots leaves the cut score null on the opening shot", () => {
  const shots = buildShots({ cuts: [{ timeSec: 4, score: 0.9 }], durationSec: 10, frameRate: 30 });
  assert.equal(shots[0].cutScore, null);
  assert.equal(shots[1].cutScore, 0.9);
});

test("buildShots drops cuts outside the media range instead of producing empty shots", () => {
  const cuts = [
    { timeSec: -1, score: null },
    { timeSec: 0, score: null },
    { timeSec: 10, score: null },
    { timeSec: 12, score: null },
  ];
  const shots = buildShots({ cuts, durationSec: 10, frameRate: 30 });
  assert.equal(shots.length, 1);
  assert.equal(shots[0].startSec, 0);
  assert.equal(shots[0].endSec, 10);
  for (const shot of shots) assert.ok(shot.durationSec > 0);
});

test("buildShots rejects an invalid duration instead of guessing one", () => {
  assert.throws(() => buildShots({ cuts: [], durationSec: 0, frameRate: 30 }), /有效时长/);
  assert.throws(() => buildShots({ cuts: [], durationSec: Number.NaN, frameRate: 30 }), /有效时长/);
});

test("defaults match the verified parameters documented in SKILL.md", () => {
  assert.equal(DEFAULT_SCENE_THRESHOLD, 0.25);
  assert.equal(DEFAULT_MIN_CUT_GAP_SEC, 0.1);
});
