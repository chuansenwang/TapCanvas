// 导入前快照：导出当前 comfyui 模型行，作为可回滚依据（只读导出，不改数据库）。
const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config({ path: `${__dirname}/../.env` });

const prisma = new PrismaClient();

async function main() {
  const models = await prisma.model_catalog_models.findMany({ where: { vendor_key: "comfyui" } });
  const vendor = await prisma.model_catalog_vendors.findFirst({ where: { key: "comfyui" } });
  const outPath = path.join(__dirname, "..", "..", "..", ".scratch", "comfyui-catalog-backup-before-qwen-edit.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    `${JSON.stringify({ exportedAt: new Date().toISOString(), vendor, models }, null, 2)}\n`,
    "utf8",
  );
  console.log(`已导出 ${models.length} 条模型记录 -> ${outPath}`);
}

main()
  .catch((error) => {
    console.error("backup failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
