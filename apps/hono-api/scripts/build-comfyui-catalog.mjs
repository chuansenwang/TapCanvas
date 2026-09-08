import fs from "node:fs";
import path from "node:path";

const downloads = "C:/Users/ASDWERT/Downloads";
const output = path.join(downloads, "TapCanvas-ComfyUI-model-catalog.json");

function workflow(fileName) {
  const filePath = path.join(downloads, fileName);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function variant(id, fileName, taskKind, referenceImageCount, options = {}) {
  return {
    id,
    name: id,
    taskKind,
    referenceImageCount,
    workflow: workflow(fileName),
    ...(options.capability ? { capability: options.capability } : {}),
    ...(options.h3Mode ? { h3Mode: options.h3Mode } : {}),
    ...(options.h3InputMode ? { h3InputMode: options.h3InputMode } : {}),
    ...(options.promptNodeIds ? { promptNodeIds: options.promptNodeIds } : {}),
    ...(options.imageNodeIds ? { imageNodeIds: options.imageNodeIds } : {}),
    ...(options.outputNodeIds ? { outputNodeIds: options.outputNodeIds } : {}),
    ...(options.mediaLoaderNodeIds ? { mediaLoaderNodeIds: options.mediaLoaderNodeIds } : {}),
    ...(options.outputMediaType ? { outputMediaType: options.outputMediaType } : {}),
    ...(options.audioLoaderNodeIds ? { audioLoaderNodeIds: options.audioLoaderNodeIds } : {}),
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
  meta: { ...(model.kind === "video" ? { videoOptions: model.videoOptions } : model.kind === "audio" ? { tags: ["tapcanvas:audio-type=speech"] } : { imageOptions }), comfyui: { workflowVariants: model.variants } },
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
