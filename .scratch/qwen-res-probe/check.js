// 验证参考图编码分辨率绑定：不同画布尺寸的换算结果与缺尺寸时的显式失败。
const fs = require("fs");
const m = require("../../apps/hono-api/src/modules/task/comfyui-workflow.ts");

const cat = JSON.parse(fs.readFileSync("C:/Users/ASDWERT/Downloads/TapCanvas-ComfyUI-model-catalog.json", "utf8"));
const model = cat.vendors[0].models.find((x) => x.modelKey === "qwen-image-2.1");
const config = m.parseComfyUiWorkflowConfig(model.meta, "qwen-image-2.1");
const variant = m.selectComfyUiWorkflowVariant(config, {
  modelKey: "qwen-image-2.1",
  taskKind: "image_edit",
  referenceImageCount: 2,
});

console.log("工作流默认 resolution:", variant.workflow["485"].inputs.resolution);

const cases = [
  { label: "1280x720 (720P横)", width: 1280, height: 720 },
  { label: "720x1280 (720P竖)", width: 720, height: 1280 },
  { label: "1792x1024 (宽幅大图)", width: 1792, height: 1024 },
  { label: "1024x1792 (竖幅大图)", width: 1024, height: 1792 },
];

for (const item of cases) {
  const wf = m.applyComfyUiWorkflowInputs(
    variant,
    {
      kind: "image_edit",
      prompt: "改成夜景",
      width: item.width,
      height: item.height,
      extras: { modelKey: "qwen-image-2.1", aspectRatio: "16:9" },
    },
    ["example.png", "img.png"],
    1,
    [],
  );
  const res = wf["485"].inputs.resolution;
  const expected = Math.round(Math.sqrt(item.width * item.height) / 32) * 32;
  console.log(`${item.label}: resolution=${res} (期望 ${expected}, 32 对齐=${res % 32 === 0})`);
}

// 未携带画布尺寸：应保留默认值（1280 落在 32-4096 内）。
const noSize = m.applyComfyUiWorkflowInputs(
  variant,
  { kind: "image_edit", prompt: "改成夜景", extras: { modelKey: "qwen-image-2.1" } },
  ["example.png"],
  1,
  [],
);
console.log("未携带画布尺寸 -> resolution:", noSize["485"].inputs.resolution);
