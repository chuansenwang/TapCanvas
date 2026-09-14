---
name: see-through-character-decomposition
description: 使用本机 See-through 将完整角色图拆成可动画的透明部件，并验证下装、腿部或鞋部等下半身部件不是空图。适用于需要为 HyperFrames 或 Live2D 风格二维角色动画准备素材的场景。
---

# See-through 完整角色拆分

本 Skill 用于把一张完整角色图交给本机 `F:/aigc/aigc/see-through` 推理管线，产出可追溯的透明部件和空间元数据。

## 必须遵守

- 每次推理必须写入新的、此前不存在的输出目录；不得覆盖已有 `workspace` 结果。
- 使用 See-through 的全流程脚本 `inference/scripts/inference_psd_quantized.py`，不要把中间标签索引或原始 1280 画布文件误当成最终部件合同。
- 完成后必须运行 `scripts/validate_complete_character.py`。它会检查最终 `optimized/info.json`、所列部件的 alpha、原始下装/腿部图层，以及人体透明边界的底部覆盖。仅有鞋部不构成可动画腿部。
- 面向完整人物动画时，验证失败即表示拆分失败：不得以原图裁切、静态下半身或伪造透明图层冒充可动画腿部资产。可以保留失败产物供排查，但要明确说明失败原因。
- 若验证通过，才能把 `optimized/info.json` 和其 PNG 部件作为 HyperFrames 的可动画输入。

## 执行

从 `F:/aigc/aigc/see-through` 运行。推荐固定随机种子、记录命令和输出目录：

```powershell
$python = 'F:/aigc/aigc/see-through/.venv/Scripts/python.exe'
$source = 'F:/输入图.png'
$output = 'F:/aigc/aigc/see-through/workspace/<新的运行目录>'
& $python inference/scripts/inference_psd_quantized.py `
  --srcp $source `
  --save_dir $output `
  --seed 42 `
  --resolution 1280 `
  --resolution_depth 768 `
  --num_inference_steps 30 `
  --tblr_split
& $python F:/aigc/aigc/TapCanvas/.agents/skills/see-through-character-decomposition/scripts/validate_complete_character.py `
  --result-dir (Join-Path $output ([IO.Path]::GetFileNameWithoutExtension($source)))
```

对于竖图或下半身较小的输入，先核对源图的透明人物边界是否完整。人物在透明画布中占比过小时，先在新的输入文件中裁出完整人物边界并保留少量留白，再推理；不得覆盖用户原图。然后调整推理分辨率、采样步数或种子重试。不要仅因命令退出码为零就认定拆分成功。

如果 LayerDiff 的 `bottomwear` 和 `legwear` 仍为空，不要反复把同一个失败图层交给动画。可使用本机 `sam_body_parsing` 的真实语义遮罩补充分割；它只保留原图中模型识别到的下装、腿部或鞋部像素，不生成被遮挡的内容：

```powershell
& $python F:/aigc/aigc/TapCanvas/.agents/skills/see-through-character-decomposition/scripts/extract_semantic_lower_body.py `
  --source <完整人物透明PNG> `
  --output-dir <新的语义下半身输出目录>
```

该输出的 `semantic-info.json` 记录模型、来源图片、alpha 像素数与坐标。将它用于 HyperFrames 时，只能做小幅平移、摆动或呼吸式动画；它不是遮挡区域重建，不得宣称能完成大幅走路或踢腿。

## 输出合同

成功结果的 `optimized/info.json` 至少需要包含 `frame_size` 和可定位部件的 `xyxy`、`depth_median`。完整角色还必须存在一个非空的 `bottomwear` 或 `legwear` 最终部件，并延伸到原始人物透明边界的下部；`footwear` 只能补充脚部，不能独立通过验收。

验证脚本的 `--json` 可用于在 TapCanvas 接入中记录结构化诊断。
