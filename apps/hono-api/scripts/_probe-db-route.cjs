// 端到端只读验证：从数据库真实记录解析 Qwen 图编辑变体，并提交到本地 ComfyUI 校验。
// 不修改数据库；提交后立即中断并清空队列。
const { PrismaClient } = require("@prisma/client");
require("dotenv").config({ path: `${__dirname}/../.env` });
const m = require("../src/modules/task/comfyui-workflow.ts");

const prisma = new PrismaClient();

async function main() {
  const row = await prisma.model_catalog_models.findFirst({
    where: { vendor_key: "comfyui", model_key: "qwen-image-2.1" },
  });
  if (!row) throw new Error("数据库缺少 qwen-image-2.1 记录");

  const meta = JSON.parse(row.meta);
  const config = m.parseComfyUiWorkflowConfig(meta, "qwen-image-2.1");
  const variant = m.selectComfyUiWorkflowVariant(config, {
    modelKey: "qwen-image-2.1",
    taskKind: "image_edit",
    referenceImageCount: 3,
  });
  console.log("路由命中的变体:", variant.id, "| 参考图区间:", JSON.stringify(variant.referenceImageRange));

  const workflow = m.applyComfyUiWorkflowInputs(
    variant,
    {
      kind: "image_edit",
      prompt: "把画面改成夜晚，并给人物加上一件红色斗篷",
      extras: { modelKey: "qwen-image-2.1", aspectRatio: "16:9" },
    },
    ["example.png", "img.png", "beach.jpg"],
    8888,
    [],
  );
  const slots = Object.keys(workflow["485"].inputs).filter((k) => k.startsWith("images.")).length;
  console.log("485 参考图槽位:", slots, "| 编码分辨率:", workflow["485"].inputs.resolution);
  console.log("输出节点:", Object.entries(workflow).filter(([, n]) => /^SaveImage/.test(String(n.class_type))).map(([id, n]) => `${id}:${n.class_type}`).join(", "));

  const res = await fetch("http://127.0.0.1:8188/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "tapcanvas-db-route-probe" }),
  });
  const body = await res.json();
  console.log("ComfyUI 提交 status:", res.status, "| node_errors:", JSON.stringify(body.node_errors ?? {}));

  await fetch("http://127.0.0.1:8188/interrupt", { method: "POST" });
  await fetch("http://127.0.0.1:8188/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clear: true }),
  });
  console.log("已中断并清空队列");
}

main()
  .catch((error) => {
    console.error("probe failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
