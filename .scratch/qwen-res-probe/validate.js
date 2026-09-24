// 向本地 ComfyUI 提交真实 /prompt 校验：确认写入编码分辨率后的节点图被接受。
const fs = require("fs");
const path = require("path");
const m = require("../../apps/hono-api/src/modules/task/comfyui-workflow.ts");

const base = "http://127.0.0.1:8188";

async function main() {
  const cat = JSON.parse(fs.readFileSync("C:/Users/ASDWERT/Downloads/TapCanvas-ComfyUI-model-catalog.json", "utf8"));
  const model = cat.vendors[0].models.find((x) => x.modelKey === "qwen-image-2.1");
  const config = m.parseComfyUiWorkflowConfig(model.meta, "qwen-image-2.1");
  const variant = m.selectComfyUiWorkflowVariant(config, {
    modelKey: "qwen-image-2.1",
    taskKind: "image_edit",
    referenceImageCount: 2,
  });
  const wf = m.applyComfyUiWorkflowInputs(
    variant,
    {
      kind: "image_edit",
      prompt: "把画面改成夜晚，并给人物加上一件红色斗篷",
      width: 1280,
      height: 720,
      extras: { modelKey: "qwen-image-2.1", aspectRatio: "16:9" },
    },
    ["example.png", "img.png"],
    4242,
    [],
  );
  console.log("写入的编码分辨率:", wf["485"].inputs.resolution);

  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "tapcanvas-res-validate" }),
  });
  const body = await res.json();
  console.log("status:", res.status);
  console.log("body:", JSON.stringify(body).slice(0, 1200));

  await fetch(`${base}/interrupt`, { method: "POST" });
  await fetch(`${base}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clear: true }),
  });
  console.log("已中断并清空队列");
}

main().catch((error) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
