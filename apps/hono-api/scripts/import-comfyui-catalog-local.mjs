// 本地一次性导入：把 build-comfyui-catalog.mjs 生成的 ComfyUI 目录写入 model_catalog_models。
// 只 upsert vendorKey=comfyui 的模型行，不删除任何既有记录。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: path.resolve(import.meta.dirname, "../.env") });

const catalogPath = process.argv[2];
if (!catalogPath) {
  throw new Error("用法: node scripts/import-comfyui-catalog-local.mjs <catalog.json>");
}

const pkg = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const bundle = pkg.vendors[0];
const vendor = bundle.vendor;
const nowIso = new Date().toISOString();
const prisma = new PrismaClient();

try {
  await prisma.model_catalog_vendors.upsert({
    where: { key: vendor.key },
    create: {
      key: vendor.key,
      name: vendor.name,
      enabled: vendor.enabled ? 1 : 0,
      base_url_hint: vendor.baseUrlHint ?? null,
      auth_type: vendor.authType ?? "bearer",
      auth_header: null,
      auth_query_param: null,
      meta: vendor.meta ? JSON.stringify(vendor.meta) : null,
      created_at: nowIso,
      updated_at: nowIso,
    },
    update: {
      name: vendor.name,
      enabled: vendor.enabled ? 1 : 0,
      base_url_hint: vendor.baseUrlHint ?? null,
      auth_type: vendor.authType ?? "bearer",
      meta: vendor.meta ? JSON.stringify(vendor.meta) : null,
      updated_at: nowIso,
    },
  });

  const results = [];
  for (const model of bundle.models) {
    const modelKey = String(model.modelKey).trim();
    const meta = model.meta ? JSON.stringify(model.meta) : null;
    await prisma.model_catalog_models.upsert({
      where: { vendor_key_model_key: { vendor_key: vendor.key, model_key: modelKey } },
      create: {
        model_key: modelKey,
        vendor_key: vendor.key,
        model_alias: model.modelAlias ?? modelKey,
        label_zh: model.labelZh,
        kind: model.kind,
        enabled: model.enabled ? 1 : 0,
        meta,
        created_at: nowIso,
        updated_at: nowIso,
      },
      update: {
        model_alias: model.modelAlias ?? modelKey,
        label_zh: model.labelZh,
        kind: model.kind,
        enabled: model.enabled ? 1 : 0,
        meta,
        updated_at: nowIso,
      },
    });
    results.push(`${modelKey} (${model.kind})`);
  }
  console.log(JSON.stringify({ imported: results }, null, 1));
} finally {
  await prisma.$disconnect();
}
