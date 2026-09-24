import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFormProfile,
  percentile,
  renderFormProfileMarkdown,
  summarizeNumbers,
} from "../lib/form-profile.mjs";

/** 造一个时长自洽的镜头，避免测试数据本身就违反模块的自洽校验。 */
function shot(startSec, endSec) {
  return { startSec, endSec, durationSec: endSec - startSec };
}

test("percentile interpolates between neighbours", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
});

test("percentile returns null for empty input instead of zero", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile(null, 0.5), null);
});

test("summarizeNumbers reports a full distribution", () => {
  assert.deepEqual(summarizeNumbers([1, 2, 3, 4]), {
    count: 4,
    min: 1,
    max: 4,
    mean: 2.5,
    median: 2.5,
    p25: 1.75,
    p75: 3.25,
  });
});

test("summarizeNumbers returns null for empty input rather than a zero-valued object", () => {
  assert.equal(summarizeNumbers([]), null);
});

test("buildFormProfile computes shot rhythm from real boundaries", () => {
  const profile = buildFormProfile({
    shots: [shot(0, 5), shot(5, 15), shot(15, 60)],
    durationSec: 60,
    source: { videoId: "demo" },
  });
  assert.equal(profile.shotLayer.shotCount, 3);
  assert.equal(profile.shotLayer.cutsPerMinute, 3);
  assert.equal(profile.shotLayer.medianShotSec, 10);
  assert.equal(profile.shotLayer.minShotSec, 5);
  assert.equal(profile.shotLayer.maxShotSec, 45);
  assert.equal(profile.source.videoId, "demo");
  assert.equal(profile.schemaVersion, "film-form-profile/v1");
});

test("buildFormProfile counts the documented duration buckets", () => {
  const profile = buildFormProfile({
    // 时长依次为 1.5s、1.8s、46.7s：前两个落在 2 秒档内，最后一个落在 30 秒档外。
    shots: [shot(0, 1.5), shot(1.5, 3.3), shot(3.3, 50)],
    durationSec: 50,
  });
  assert.equal(profile.shotLayer.distribution.under2Sec, 2);
  assert.equal(profile.shotLayer.distribution.under5Sec, 2);
  assert.equal(profile.shotLayer.distribution.over30Sec, 1);
  assert.equal(profile.shotLayer.distribution.over60Sec, 0);
});

test("buildFormProfile leaves the speech layer null when no subtitles were requested", () => {
  const profile = buildFormProfile({ shots: [shot(0, 10)], durationSec: 10 });
  assert.equal(profile.speechLayer, null);
});

test("buildFormProfile computes speech rate from real segments", () => {
  const profile = buildFormProfile({
    shots: [shot(0, 10)],
    durationSec: 10,
    segments: [
      { start: 0, end: 2, text: "你好世界" },
      { start: 2, end: 4, text: "再见" },
    ],
  });
  assert.equal(profile.speechLayer.segmentCount, 2);
  assert.equal(profile.speechLayer.totalChars, 6);
  assert.equal(profile.speechLayer.charsPerSecond, 0.6);
  assert.equal(profile.speechLayer.medianCharsPerSegment, 3);
});

test("buildFormProfile counts characters by code point, not UTF-16 units", () => {
  // 单个 emoji 在 UTF-16 里长度为 2，按字符数应记为 1。
  const profile = buildFormProfile({
    shots: [shot(0, 1)],
    durationSec: 1,
    segments: [{ start: 0, end: 1, text: "😀" }],
  });
  assert.equal(profile.speechLayer.totalChars, 1);
});

test("buildFormProfile fails on empty shots instead of inventing a profile", () => {
  assert.throws(() => buildFormProfile({ shots: [], durationSec: 10 }), /非空的镜头数组/);
});

test("buildFormProfile fails when a shot has an invalid range", () => {
  assert.throws(
    () => buildFormProfile({ shots: [shot(5, 5)], durationSec: 10 }),
    /区间非法/,
  );
});

test("buildFormProfile fails when durationSec disagrees with the range", () => {
  assert.throws(
    () =>
      buildFormProfile({
        shots: [{ startSec: 0, endSec: 10, durationSec: 3 }],
        durationSec: 10,
      }),
    /与区间 .* 不一致/,
  );
});

test("buildFormProfile fails on an invalid media duration", () => {
  assert.throws(
    () => buildFormProfile({ shots: [shot(0, 1)], durationSec: 0 }),
    /有效的媒体时长/,
  );
});

test("renderFormProfileMarkdown states that the speech layer is missing", () => {
  const markdown = renderFormProfileMarkdown(
    buildFormProfile({ shots: [shot(0, 10)], durationSec: 10 }),
  );
  assert.match(markdown, /未提供字幕证据/);
  assert.match(markdown, /镜头数 \| 1/);
});

test("renderFormProfileMarkdown reports the measured speech numbers", () => {
  const markdown = renderFormProfileMarkdown(
    buildFormProfile({
      shots: [shot(0, 10)],
      durationSec: 10,
      segments: [{ start: 0, end: 2, text: "你好世界" }],
    }),
  );
  assert.match(markdown, /语速 \| 0\.4 字\/秒/);
  assert.doesNotMatch(markdown, /未提供字幕证据/);
});
