// 只读检查：对比数据库现有 qwen-image-2.1 记录与待导入目录的差异。
const fs = require("node:fs");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config({ path: `${__dirname}/../.env` });

const prisma = new PrismaClient();

async function main() {
  const pkg = JSON.parse(fs.readFileSync("C:/Users/ASDWERT/Downloads/TapCanvas-ComfyUI-model-catalog.json", "utf8"));
  const bundle = pkg.vendors[0];
  const incoming = bundle.models.find((m) => m.modelKey === "qwen-image-2.1");

  const row = await prisma.model_catalog_models.findFirst({
    where: { vendor_key: "comfyui", model_key: "qwen-image-2.1" },
  });
  if (!row) {
    console.log("数据库: 无记录（将新增）");
    return;
  }
  const current = JSON.parse(row.meta);
  console.log("数据库现有 variants:", current.comfyui.workflowVariants.map((v) => `${v.id}/${v.taskKind}`).join(", "));
  console.log("待导入 variants:  ", incoming.meta.comfyui.workflowVariants.map((v) => `${v.id}/${v.taskKind}`).join(", "));
  console.log("数据库现有 imageOptions:", JSON.stringify(current.imageOptions));
  console.log("待导入 imageOptions:  ", JSON.stringify(incoming.meta.imageOptions));
  console.log("label_zh 数据库:", row.label_zh, "| 待导入:", incoming.labelZh);
  console.log("enabled 数据库:", row.enabled);
}

main()
  .catch((error) => {
    console.error("probe failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
