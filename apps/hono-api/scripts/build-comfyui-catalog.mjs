import fs from "node:fs";
import path from "node:path";

const downloads = "C:/Users/ASDWERT/Downloads";
const output = path.join(downloads, "TapCanvas-ComfyUI-model-catalog.json");

function workflow(fileName) {
  const filePath = path.join(downloads, fileName);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * 从 ComfyUI 编辑器导出的 API 工作流里裁掉执行无关的节点，得到可提交的节点图。
 *
 * 导出文件常混入编辑器专用的预览链（ImageConcatMulti 对比图、重复 SaveImageAdvanced/SaveImage）
 * 以及与本变体无关的旁支（例如同一文件里另一条文生图链）。这些节点会被 ComfyUI 当作输出节点
 * 真实执行并落盘，导致一次请求产出多张非目标图。这里按显式 id 删除，并清理指向已删除节点的
 * 悬空连线；不做任何猜测式裁剪。
 */
function pruneWorkflow(source, removedNodeIds) {
  const removed = new Set(removedNodeIds.map((id) => String(id)));
  const pruned = {};
  for (const [nodeId, node] of Object.entries(source)) {
    if (removed.has(nodeId)) continue;
    pruned[nodeId] = JSON.parse(JSON.stringify(node));
  }
  for (const node of Object.values(pruned)) {
    if (!node.inputs || typeof node.inputs !== "object") continue;
    for (const [inputKey, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value.length !== 2) continue;
      if (removed.has(String(value[0]))) delete node.inputs[inputKey];
    }
  }
  return pruned;
}

function variant(id, fileName, taskKind, referenceImageCount, options = {}) {
  return {
    id,
    name: id,
    taskKind,
    // 定数变体声明 referenceImageCount；动态区间变体传 null，改为声明 referenceImageRange。
    ...(typeof referenceImageCount === "number" ? { referenceImageCount } : {}),
    workflow: options.workflowOverride || workflow(fileName),
    ...(options.referenceImageRange ? { referenceImageRange: options.referenceImageRange } : {}),
    ...(options.referenceImageSlots ? { referenceImageSlots: options.referenceImageSlots } : {}),
    ...(options.referenceImageLoaderNodeIdTemplate
      ? { referenceImageLoaderNodeIdTemplate: options.referenceImageLoaderNodeIdTemplate }
      : {}),
    ...(options.capability ? { capability: options.capability } : {}),
    ...(options.h3Mode ? { h3Mode: options.h3Mode } : {}),
    ...(options.h3InputMode ? { h3InputMode: options.h3InputMode } : {}),
    ...(options.promptNodeIds ? { promptNodeIds: options.promptNodeIds } : {}),
    ...(options.promptInputBindings ? { promptInputBindings: options.promptInputBindings } : {}),
    ...(options.aspectRatioInputBindings ? { aspectRatioInputBindings: options.aspectRatioInputBindings } : {}),
    ...(options.imageResolutionInputBindings
      ? { imageResolutionInputBindings: options.imageResolutionInputBindings }
      : {}),
    ...(options.imageSizeInputBindings ? { imageSizeInputBindings: options.imageSizeInputBindings } : {}),
    ...(options.imageNodeIds ? { imageNodeIds: options.imageNodeIds } : {}),
    ...(options.outputNodeIds ? { outputNodeIds: options.outputNodeIds } : {}),
    ...(options.mediaLoaderNodeIds ? { mediaLoaderNodeIds: options.mediaLoaderNodeIds } : {}),
    ...(options.outputMediaType ? { outputMediaType: options.outputMediaType } : {}),
    ...(options.audioLoaderNodeIds ? { audioLoaderNodeIds: options.audioLoaderNodeIds } : {}),
    ...(options.mediaInputNodeBinding ? { mediaInputNodeBinding: options.mediaInputNodeBinding } : {}),
    ...(options.emotionControlNodeIds ? { emotionControlNodeIds: options.emotionControlNodeIds } : {}),
    ...(options.audioEmotionMode ? { audioEmotionMode: options.audioEmotionMode } : {}),
  };
}

const imageOptions = {
  supportsTextToImage: true,
  supportsImageToImage: true,
  supportsReferenceImages: true,
  aspectRatioOptions: ["original", "1:1", "16:9", "9:16"],
};

// Qwen Image 2.1 文生图的画幅由工作流内的 ResolutionSelector(节点 13) 决定，其控件枚举是
// "16:9 (Widescreen)" 这类带说明的值。ComfyUI 会静默忽略未知输入字段，因此这里只声明
// 能通过 valueMap 真实落到该控件的比例；不声明 "original"，避免出现界面上可选、实际不生效的选项。
const qwenImage21AspectValueMap = {
  "1:1": "1:1 (Square)",
  "4:3": "4:3 (Standard)",
  "3:4": "3:4 (Portrait Standard)",
  "16:9": "16:9 (Widescreen)",
  "9:16": "9:16 (Portrait Widescreen)",
};

const qwenImage21ImageOptions = {
  supportsTextToImage: true,
  supportsImageToImage: true,
  supportsReferenceImages: true,
  defaultAspectRatio: "16:9",
  maxReferenceImages: 16,
  aspectRatioOptions: Object.keys(qwenImage21AspectValueMap),
};

// Qwen Image 2.1 图片编辑：参考图走 TextEncodeQwenImage21 的 autogrow 槽位（images.image_1..16）
// 与提示词扩写器 BatchImagesNode 的视觉输入（images.image0..49），数量由请求动态决定。
// 需要显式删除的节点分三类：
//   1. 编辑器遗留的 LoadImage(470)：它是导出时的粘贴图，运行时由动态 LoadImage 取代；
//   2. 编辑器预览链：ImageConcatMulti(486/487) 的对比拼图、SaveImageAdvanced(496) 与 SaveImage(515)；
//   3. 同文件里与本变体无关的另一条文生图链（516..528）。
// 这些节点会被 ComfyUI 当作输出节点真实执行并落盘，必须在构建阶段删除，而不是靠运行时兜底。
const qwenImage21EditRemovedNodeIds = [
  "470", "486", "487", "496", "515",
  "516", "517", "518", "519", "520", "521", "522", "523", "524", "525", "526", "527", "528",
];

const qwenImage21EditWorkflow = pruneWorkflow(
  workflow("Qwen image 2.1图片编辑 API.json"),
  qwenImage21EditRemovedNodeIds,
);

const models = [
  {
    modelKey: "indextts-2.5",
    modelAlias: "indextts-2.5",
    labelZh: "IndexTTS 2.5（本地 ComfyUI）",
    kind: "audio",
    variants: [
      variant("emotion-basic", "INDEX2.5音频基础.json", "text_to_audio", 0, { capability: "emotion-basic", audioLoaderNodeIds: ["4"], outputNodeIds: ["3"], outputMediaType: "audio" }),
      variant("emotion-vector", "INDEX2.5音频情感向量模式.json", "text_to_audio", 0, { capability: "emotion-vector", audioLoaderNodeIds: ["5"], emotionControlNodeIds: ["4"], audioEmotionMode: "vector", outputNodeIds: ["1"], outputMediaType: "audio" }),
      variant("emotion-text", "INDEX2.5音频文本情感.json", "text_to_audio", 0, { capability: "emotion-text", audioLoaderNodeIds: ["1"], emotionControlNodeIds: ["5"], audioEmotionMode: "text", outputNodeIds: ["4"], outputMediaType: "audio" }),
    ],
  },
  {
    modelKey: "minmax-h3-audio",
    modelAlias: "minmax-h3-audio",
    labelZh: "MiniMax H3 音频（本地 ComfyUI）",
    kind: "audio",
    audioTags: ["tapcanvas:audio-type=speech", "tapcanvas:audio-engine=minimax-h3"],
    // H3 音频没有对外暴露的模型参数：时长由提示词里的台词与时间轴推导，采样步数取工作流
    // 固定配置，可用 UNET 由执行前 `/object_info` 实时枚举校验。因此不声明 runtimeParameters，
    // 避免节点上出现无实际选择权的输入框。
    variants: [
      variant("fl2va", "minih3_audio.json", "text_to_audio", 0, {
        capability: "fl2va",
        promptNodeIds: ["169"],
        audioLoaderNodeIds: ["144"],
        outputNodeIds: ["143"],
        outputMediaType: "audio",
      }),
    ],
  },
  {
    modelKey: "klein-9b",
    modelAlias: "klein-9b",
    labelZh: "Klein 9B（本地 ComfyUI）",
    variants: [
      variant("text", "Klein9B文生图.json", "text_to_image", 0, { promptNodeIds: ["121"], outputNodeIds: ["254"] }),
      variant("edit-1", "Klein9B改图1张.json", "image_edit", 1, { promptNodeIds: ["29"], imageNodeIds: ["30"], outputNodeIds: ["19"] }),
      variant("edit-2", "Klein9b双图.json", "image_edit", 2, { promptNodeIds: ["135"], imageNodeIds: ["76", "81"], outputNodeIds: ["94"] }),
      variant("edit-3", "Klein9B改图3张.json", "image_edit", 3, { promptNodeIds: ["29"], imageNodeIds: ["13", "28", "30"], outputNodeIds: ["19"] }),
      variant("character-3view", "Klein人物三视图+高清放大.json", "image_edit", 1, { capability: "character-3view", promptNodeIds: ["65"], imageNodeIds: ["45"], outputNodeIds: ["114"] }),
    ],
  },
  {
    modelKey: "qwen-image-2.1",
    modelAlias: "qwen-image-2.1",
    labelZh: "Qwen Image 2.1（本地 ComfyUI）",
    imageOptions: qwenImage21ImageOptions,
    variants: [
      // 提示词绑定在 480（TextGenerateLTX2Prompt，Qwen3.5 提示词扩写）→ 484（easy showAnything 直通）→ 471（TextEncodeQwenImage21）。
      // 不能绑定 471：它的 resolution 是 INT(0-4096)，而通用注入会把 extras.resolution（如 "2K"）以字符串写入，导致 ComfyUI 校验失败。
      variant("text", "Qwen image 2.1 文生图 API.json", "text_to_image", 0, {
        promptNodeIds: ["480"],
        outputNodeIds: ["479"],
        aspectRatioInputBindings: [{ nodeId: "13", inputKey: "aspect_ratio", valueMap: qwenImage21AspectValueMap }],
      }),
      // 图编辑：提示词同样写在 502（TextGenerateLTX2Prompt），它由 505 接收参考图做扩写；
      // 485（TextEncodeQwenImage21）才是真正把参考图拼进序列的编码器，因此两处都要接参考图。
      // 输出只保留 494（SaveImageAdvanced）；它在裁剪后已与 515 断开，不会触发额外保存。
      variant("edit", "Qwen image 2.1图片编辑 API.json", "image_edit", null, {
        workflowOverride: qwenImage21EditWorkflow,
        referenceImageRange: { min: 1, max: 16 },
        referenceImageLoaderNodeIdTemplate: "tapcanvas-ref-{index}",
        referenceImageSlots: [
          { nodeId: "485", inputKeyTemplate: "images.image_{index}", startIndex: 1, maxSlots: 16 },
          { nodeId: "505", inputKeyTemplate: "images.image{index}", startIndex: 0, maxSlots: 16 },
        ],
        promptNodeIds: ["502"],
        outputNodeIds: ["494"],
        aspectRatioInputBindings: [{ nodeId: "13", inputKey: "aspect_ratio", valueMap: qwenImage21AspectValueMap }],
        // 参考图编码分辨率：485 的 resolution 是「约 resolution² 像素」的面积等效边长
        // （节点声明 INT min=0 max=4096 step=32，0 表示保持原图尺寸）。这里按画布实际输出规模
        // 的等效边长写入并对齐 32，使横图与竖图在同一输出规模下得到一致的编码量。
        // 输出规模的真源是 13（ResolutionSelector）：megapixels=2 → 等效边长 1448 → 对齐后 1440；
        // 画布上改比例不会改 megapixels，所以该值随画幅切换保持稳定，仅随输出规模变化。
        imageResolutionInputBindings: [{ nodeId: "485", inputKey: "resolution", alignTo: 32, min: 32, max: 4096, megapixelsFromNodeId: "13" }],
      }),
    ],
  },
  {
    modelKey: "qwen-image-2512",
    modelAlias: "qwen-image-2512",
    labelZh: "Qwen Image 2512（本地 ComfyUI）",
    variants: [variant("text", "Qwen2512文生图.json", "text_to_image", 0, { promptNodeIds: ["268"], outputNodeIds: ["60"] })],
  },
  {
    modelKey: "qwen-edit-2511",
    modelAlias: "qwen-edit-2511",
    labelZh: "Qwen Edit 2511（本地 ComfyUI）",
    variants: [
      variant("edit-1", "QwenEdit2511单图.json", "image_edit", 1, { promptNodeIds: ["202"], imageNodeIds: ["41"], outputNodeIds: ["195"] }),
      variant("edit-2", "QwenEdit2511双图.json", "image_edit", 2, { promptNodeIds: ["201"], imageNodeIds: ["41", "83"], outputNodeIds: ["9"] }),
      variant("edit-3", "QwenEdit2511三图.json", "image_edit", 3, { promptNodeIds: ["201"], imageNodeIds: ["41", "83", "218"], outputNodeIds: ["9"] }),
    ],
  },
  {
    modelKey: "krea-2-fast",
    modelAlias: "krea-2-fast",
    labelZh: "Krea 2 Fast（本地 ComfyUI）",
    variants: [variant("text", "Krea2_fast文生图.json", "text_to_image", 0, { promptNodeIds: ["51"], outputNodeIds: ["29"] })],
  },
  {
    modelKey: "z-image-fast",
    modelAlias: "z-image-fast",
    labelZh: "Z Image Fast（本地 ComfyUI）",
    variants: [variant("text", "z_image_fast文生图.json", "text_to_image", 0, { promptNodeIds: ["57:27"], outputNodeIds: ["9"] })],
  },
  {
    modelKey: "z-image",
    modelAlias: "z-image",
    labelZh: "Z Image（本地 ComfyUI）",
    variants: [variant("text", "z_image文生图.json", "text_to_image", 0, { promptNodeIds: ["96"], outputNodeIds: ["95"] })],
  },
  {
    modelKey: "minimax-h3",
    modelAlias: "minimax-h3",
    labelZh: "MiniMax H3（本地 ComfyUI，多媒体生视频）",
    kind: "video",
    variants: [
      variant("text", "MiniMax_H3_Easy.json", "text_to_video", 0, { h3Mode: "image", h3InputMode: "text", promptNodeIds: ["3"], mediaLoaderNodeIds: ["42"], outputNodeIds: ["21", "23"], outputMediaType: "video" }),
      variant("first-frame", "MiniMax_H3_Easy.json", "image_to_video", 0, { h3Mode: "image", h3InputMode: "first_frame", promptNodeIds: ["3"], mediaLoaderNodeIds: ["42"], outputNodeIds: ["21", "23"], outputMediaType: "video" }),
      variant("last-frame", "MiniMax_H3_Easy.json", "image_to_video", 0, { h3Mode: "image", h3InputMode: "last_frame", promptNodeIds: ["3"], mediaLoaderNodeIds: ["42"], outputNodeIds: ["21", "23"], outputMediaType: "video" }),
      variant("first-last-frame", "MiniMax_H3_Easy.json", "image_to_video", 0, { h3Mode: "image", h3InputMode: "first_last_frame", promptNodeIds: ["3"], mediaLoaderNodeIds: ["42"], outputNodeIds: ["21", "23"], outputMediaType: "video" }),
      variant("reference", "MiniMax_H3_Easy.json", "image_to_video", 0, { h3Mode: "reference", h3InputMode: "reference", promptNodeIds: ["3"], mediaLoaderNodeIds: ["42"], outputNodeIds: ["21", "23"], outputMediaType: "video" }),
      variant("digital-human", "MiniMax_H3_Easy.json", "image_to_video", 0, { h3Mode: "digital_human", h3InputMode: "digital_human", promptNodeIds: ["3"], mediaLoaderNodeIds: ["42"], outputNodeIds: ["21", "23"], outputMediaType: "video" }),
      variant("reference-audio-legacy", "H3至尊全能工作流【鱼佬框架+吃猪侠定制版】.json", "image_to_video", 0, {
        capability: "reference-audio-legacy",
        promptInputBindings: [{ nodeId: "263", inputKey: "UNKNOWN" }],
        imageNodeIds: ["51"],
        audioLoaderNodeIds: ["48"],
        mediaInputNodeBinding: "legacy_loaders",
        outputNodeIds: ["214"],
        outputMediaType: "video",
      }),
    ],
    videoOptions: {
      defaultDurationSeconds: 4,
      defaultResolution: "720P",
      // MiniMax H3 支持 1–15 秒，4 秒仅作为界面默认值，不是唯一档位。
      durationOptions: Array.from({ length: 15 }, (_, index) => index + 1),
      resolutionOptions: ["360P", "416P", "480P", "540P", "640P", "720P", "768P", "832P", "928P", "1024P", "1080P", "custom"],
      sizeOptions: ["2:3", "16:9", "9:16"],
      supportsMultimodalReferences: true,
      supportsFirstLastFrame: true,
      supportsReferenceImages: true,
      supportsReferenceVideos: true,
      supportsReferenceAudios: true,
      maxReferenceMedia: 8,
      maxReferenceImages: 8,
      maxReferenceVideos: 4,
      maxReferenceAudios: 4,
      supportsNativeAudio: true,
    },
  },
].map((model) => ({
  modelKey: model.modelKey,
  modelAlias: model.modelAlias,
  labelZh: model.labelZh,
  kind: model.kind || "image",
  enabled: true,
  meta: {
    ...(model.kind === "video"
      ? { videoOptions: model.videoOptions }
      : model.kind === "audio"
        ? {
          tags: model.audioTags || ["tapcanvas:audio-type=speech", "tapcanvas:audio-engine=comfyui"],
          ...(model.runtimeParameters ? { runtimeParameters: model.runtimeParameters } : {}),
        }
        : { imageOptions: model.imageOptions || imageOptions }),
    comfyui: { workflowVariants: model.variants },
  },
  pricing: { cost: 0, enabled: true, specCosts: [] },
}));

const packageValue = {
  version: "tapcanvas-comfyui-v1",
  exportedAt: new Date().toISOString(),
  vendors: [{
    vendor: {
      key: "comfyui",
      name: "本地 ComfyUI",
      enabled: true,
      baseUrlHint: "http://127.0.0.1:8188",
      authType: "none",
      meta: { protocol: "comfyui-api", endpoints: ["/upload/image", "/prompt", "/history/:promptId", "/view"] },
    },
    models,
    mappings: [],
  }],
};

fs.writeFileSync(output, `${JSON.stringify(packageValue, null, 2)}\n`, "utf8");
console.log(output);
