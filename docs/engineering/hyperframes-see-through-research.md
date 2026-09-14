# HyperFrames 与 See-through 角色组件动画调研

## 结论

HyperFrames 适合作为 TapCanvas 中 See-through 角色组件拆分后的二维动画渲染器。它不是 HeyGen 的云端角色驱动接口，也不会自行识别“挥手”“眨眼”等语义动作；它会把确定的 HTML、CSS、媒体文件和可随机跳帧的动画时间线渲染为视频。因此，正确链路是：

```text
角色原图
  -> 本机 See-through：透明 RGBA 部件 + xyxy + 深度
  -> TapCanvas：用户或原生 Agent 明确动作和关键姿势
  -> HyperFrames composition：按原始坐标装配各部件、按深度排序、用确定性时间线动画
  -> HyperFrames 本地渲染：MP4（或后续开放 WebM/MOV/PNG 序列）
```

这一链路适用于轻量二维木偶动画，例如头部轻摆、身体呼吸、眼睛闭合、手臂摆动与镜头推拉。它不能凭空生成拆分结果中不存在的转身、手势细节或表情；这类动作应显式失败，或先经图生视频/重新出图产生新的视觉资产，禁止将其伪装成 HyperFrames 的能力。

## 已有项目能力

仓库已有 `tapcanvas_hyperframes_render` 服务端工具及渲染适配器：

- 输入：单文件 HTML、最多 24 个 URL 素材、帧率与质量参数。
- 素材：服务端先下载为 `./assets/<name>`，composition 必须使用该相对路径，不能直接依赖远程 URL。
- 输出：托管的 MP4 URL、存储键、字节数与通过 `ffprobe` 得到的时长。
- 安全边界：HTML 最大 512 KiB、素材总量最大 200 MiB、帧率限制为 12 至 60。

See-through 的 `characterDecomposition.parts` 已包含 `tag`、部件 URL、`xyxy`、`depthMedian` 和原始画面尺寸；这些字段足以作为 HyperFrames 的初始空间装配事实。CSS `z-index` 应按深度数据排序；每个部件的定位和尺寸应来自 `xyxy`，而非对角色结构作本地猜测。

## HyperFrames 必须遵守的 composition 合同

1. 根节点必须有唯一 `data-composition-id`，并显式提供 `data-start="0"`、`data-width`、`data-height` 和固定 `data-duration`。
2. 透明部件可使用 `<img src="./assets/<name>">`，置于固定尺寸的容器内。各部件应依 `xyxy` 计算初始 left、top、width、height，视觉前后关系由 `z-index` 表达。`data-track-index` 只是 Studio 时间轴显示顺序，不控制绘制层级。
3. 可动画的部件应放在保留初始几何关系的内层 wrapper 中。优先动画 `transform` 与 `opacity`，避免在逐帧渲染中反复修改 `top`、`left`、`width` 或 `height`。
4. 使用 GSAP 时必须同步创建一个 `{ paused: true }` 的有限时间线，并登记到 `window.__timelines[compositionId]`。时间线由 HyperFrames 驱动，不能 `play()`，不能用计时器、随机数或按连续播放累积的状态。
5. 所有素材文件名必须由后端生成并受限为单层相对路径；HTML 只引用后端预下载后的 `./assets/<name>`。

## 最小可交付动作合同建议

新增一个通用的“角色组件动画”执行合同，而不是将“挥手”硬编码进 UI：

```ts
type CharacterPartMotion = {
  partId: string;
  transformOrigin: { x: number; y: number };
  keyframes: Array<{
    atSec: number;
    translateX: number;
    translateY: number;
    rotateDeg: number;
    scaleX: number;
    scaleY: number;
    opacity: number;
  }>;
};

type CharacterComponentAnimation = {
  durationSec: number;
  fps: 24 | 30 | 60;
  motions: CharacterPartMotion[];
};
```

生成器只把这份结构化动画合同编译为 HyperFrames HTML；它不解释自然语言、不猜骨骼、不补造缺失部件。语义动作规划应由原生 Agent 产出为该合同，前端和 Hono 仅进行类型、时间范围、部件存在性、资产 URL 与数值边界校验。

针对首个测试，建议约 4 秒、24fps：躯干轻微呼吸、头部左右摆动、前发小幅跟随、右手以肩部为 transform-origin 上抬再回落。只有当 See-through 实际输出了对应手臂/手部独立组件时才允许手势动画；若只有合并身体层，必须在 UI 中报明“该部件不可单独驱动”。

## 当前适配层的缺口

当前 `renderHyperframesComposition()` 只暴露 MP4。HyperFrames 官方 producer 原生还支持透明 WebM、ProRes 4444 MOV 与 PNG 序列，但不应在未完成存储 MIME、产物验证和前端消费合同之前提前暴露。首个角色动作测试保持 MP4 即可；若后续要交给视频编辑器进行再合成，再扩展一个显式的 `format` 枚举及对应输出校验。

当前 24 个素材上限可能低于复杂角色的部件数。第一次接入必须基于真实 See-through 输出部件数量验证；超过上限时应明确失败并报告实际数和限制值，不能静默丢弃组件。

## 一手资料

- HyperFrames 官方仓库 README：<https://github.com/heygen-com/hyperframes/blob/main/README.md>
- 官方 HTML schema：<https://hyperframes.heygen.com/reference/html-schema>
- 官方 GSAP 动画合同：<https://hyperframes.heygen.com/guides/gsap-animation>
- 官方渲染与透明输出说明：<https://hyperframes.heygen.com/guides/rendering>
- 官方 Producer API 与透明格式：<https://github.com/heygen-com/hyperframes/blob/main/packages/producer/README.md>

