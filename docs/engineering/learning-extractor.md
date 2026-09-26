# AI 错误经验登记流水

- **背景**：用户要求音频节点去掉「时长/步数」参数——时长应由台词决定、步数用工作流配置即可。
- **现象与根因**：改动落在了执行器、目录生成脚本、前端请求与提示词文档里，随后被当作已完成交付；用户复核界面后指出「感觉没变化」，节点仍显示 `1` 与 `10` 两个输入框。根因是这些控件由**已导入的模型目录数据**（`model_catalog_models.meta.runtimeParameters`）驱动，而数据库中该行仍声明 `duration`/`steps`；只改生成脚本不会改变已导入数据，我也未在交付前核对用户可见结果。
- **处置与预防**：代码侧已移除 H3 的 `duration`/`steps` 入参与目录声明，并同步 README、工具 schema 与 Agent skill；数据侧仍需更新已导入的目录行才能让界面生效。凡改动「由数据驱动的 UI」，交付前必须先确认数据本身是否已同步，并区分「源码已改」与「用户已可见生效」两件事，不得只凭代码改动就宣告完成。

- **背景**：接入本机 See-through 角色组件拆分，需要把透明部件与空间元数据交给 HyperFrames。
- **现象与根因**：初版适配器把首轮输出目录的 `info.json` 当作最终元数据，真实文件只有部件标签索引，缺少 `frame_size`、`xyxy` 与 `depth_median`。根因是仅从上游推理流程的局部源码推断了输出位置，未先核验已有运行产物。
- **处置与预防**：适配器已改为读取后处理生成的 `source/optimized/info.json`，并新增测试拒绝中间索引格式。今后接入本机推理工具时，必须先以已有真实输出验证目录层级和字段合同，再实现解析器。

本文件记录已确认的单次 AI 错误事件。每次事件使用三个 bullet：`背景`、`现象与根因`、`处置与预防`。同类事件升级为长期经验后，保留原始记录并关联 `HE-FL-XXX`。

- **背景**：用户给出一张 4x3 共 12 格的铅笔分镜表（每格叠加了彩色轨迹箭头、图例与镜头编号），要求用本机 ComfyUI 的 MiniMax H3 生成视频。我切分单格后直接提交了 P01，并在切分脚本里声称「排除底部中文说明，避免被当成画面字幕」。
- **现象与根因**：抽帧后确认，P01 首帧把左上角的颜色图例、红色轨迹箭头与「P01」编号原样带了进来，视频里这些标注被当作画面内容继续存在；后续批次还暴露出第二个更严重的问题——铅笔手绘风格被 H3 整体沿用，12 段视频里有的像实拍、有的仍是线稿，风格不统一。根因有两点：一是判定「分镜切分有效」时只验证了切框坐标与像素带分析，没有回看首帧本身是否仍含标注，属于用推导结果代替视觉核验；二是没有把「分镜原稿是铅笔稿、文案却是实拍镜头语言」这一事实前置，导致输入素材与目标产物在风格上不一致时才被动发现。
- **处置与预防**：已改为两段式前置处理——先用 Qwen-Image-Edit-2511 逐格擦除全部标注（含镜头编号），再统一转换为写实电影首帧，确认 12 格风格一致后才提交 H3；P11 首次擦除后编号仍有残留，二次处理后复核通过。最终 12 段全部为写实风格且带原生音频。今后凡「图表 / 分镜 / 截图作为生成模型首帧」的任务，必须在批量提交前先抽检首帧画面本身（是否残留标注、编号、水印、非目标画风），并先确认输入风格与目标产物一致，再进入批量生成；不得仅凭切框参数正确就判定素材可用。

- **背景**：基于 See-through 透明部件生成 HyperFrames 角色挥手测试视频。
- **现象与根因**：首版视频缺少腿部，仍被错误表述为可供用户查看的完整角色测试。根因是只验证了 `optimized/info.json` 的存在和视频渲染成功，未验证下装、腿部、鞋部图层的 alpha 与人物下部覆盖；复核后确认 `bottomwear.png`、`legwear.png`、`footwear.png` 的 alpha 均为空。
- **处置与预防**：新增 `see-through-character-decomposition` Skill 及验收脚本；完整角色任务必须核验原始和最终下半身部件的非空 alpha、下部覆盖及最终元数据标签，任一条件不满足即显式失败，禁止用静态原图裁切冒充可动画腿部部件。

- **背景**：以 NF4 量化模式重新执行 See-through 完整角色拆分，并用新增验收脚本判定腿部资产。
- **现象与根因**：20 步结果仅生成了覆盖角色底部的 `footwear`，`bottomwear` 与 `legwear` 的 alpha 均为空；脚本却因把鞋部列入充分条件而返回通过。根因是“下半身存在像素”被错误实现为“鞋子存在即可代表腿部”。
- **处置与预防**：验收改为必须由 `bottomwear` 或 `legwear` 之一以非空 alpha 覆盖角色下部；鞋部仅作补充信息，不能单独满足完整人物动画交付。失败结果保留用于比对，但禁止交给 HyperFrames 作为腿部可动画资产。

- **背景**：MiniMax H3 生成的英文测试音频含有明显首尾静音。
- **现象与根因**：此前只记录完整 ComfyUI 输出并直接作为交付 WAV，导致段首伪影区、首尾环境声铺垫被当作成品时长返回。根因是遗漏了用户文档第 10 节对首秒伪影和尾部静音的明确客户端裁剪建议。
- **处置与预防**：已保留原始 FLAC 作为来源资产；交付 WAV 固定先移除首秒伪影窗、再只清理其后的起始连续静音，内部停顿和后续声音不变；返回时长改为处理后 WAV 的 `ffprobe` 实测值，并同时记录来源 URL 与来源时长。

- **背景**：实现 H3 音频首尾裁剪后，用户质疑“是否所有生成的开头固定是 1 秒脏数据”。
- **现象与根因**：起初把“段首约 1 秒内可能有轻微伪影”孤立理解为概率性失效窗口，忽略文档 Prompt 规则同时强制“开场留 1 秒无人声明”。该首秒在 H3 合同中是专门为规避伪影设置的预卷，而非有效台词内容。
- **处置与预防**：交付 WAV 固定移除 H3 Prompt 合同规定的首秒无人声预卷，再仅清理其后的起始静音；不自动裁尾。原始 FLAC 仍保留，时长仍以处理后实测为准。任何需要从 0 秒发声的音频不得使用这个 H3 合同，而应改用其他支持零前导的执行器。

- **背景**：14 秒 H3 双角色对话测试使用尾端响度阈值裁剪后，用户反馈开头太赶且后续声音被裁掉。
- **现象与根因**：`silenceremove` 的尾端反转检测将渐弱台词、远景声或低音量环境声误认为尾部静音，交付文件从 14.375 秒缩短到 10.927 秒。根因是把“文档建议裁掉尾部静音”误实现为不理解声学语义的响度阈值自动删除。
- **处置与预防**：保留 H3 合同首秒预卷和首端静音的处理，但停止所有自动尾端裁剪；完整保留请求时长内的后续声音并以保守交付文件实测时长返回。原始 FLAC 继续留存以供追溯。

- **背景**：H3 交付 WAV 移除起始连续静音后，用户反馈播放器从 0 秒立刻切入人声，听感急促。
- **现象与根因**：首端 `silenceremove` 后直接输出第一个有效采样，交付滤镜没有保留前导缓冲。根因是将“清理多余起始静音”错误等同于“前导静音必须为零”。
- **处置与预防**：交付滤镜在首秒预卷移除与起始静音清理后固定加入 50ms 前导静音。该垫片只改善播放起点，不改变有效声音、不改变尾端策略，处理后时长仍通过 `ffprobe` 实测。

- **背景**：使用 5 秒 MiniMax H3 英文音频测试 `<d>[English] Good morning. The test is ready.</d>`。
- **现象与根因**：首版提示词在对白前堆叠了阅读、抬头、呼吸等动作，成品的主要人声直到约 3 秒后才出现。根因是把视觉铺陈写在短音频的台词之前，H3 将其解释为对白前的实际时长，而非仅作背景描述。
- **处置与预防**：对照 Prompt 将第一句放入第二镜的第一动作，并明确 `At exactly 00:01.000` 与立即起声边界后，有效声段提前到约 1.68 秒。已将短音频首镜最小化、立即起声的规则写入 H3 Audio Skill；不通过后处理裁剪掩盖时序问题。

- **背景**：接入用户提供的 MiniMax H3 TTS 文档及其已运行的本地 ComfyUI。
- **现象与根因**：曾将文档中的 `8199 /generate` 封装服务误当作用户指定的接入目标，并据此建议 TapCanvas 请求 8199；实际用户要求复用自己已运行的 `8188` ComfyUI。根因是没有先区分文档中的可选封装层与用户明确指定的服务边界。
- **处置与预防**：已改为直连 `8188` 的 `/upload/image`、`/prompt`、`/history/{prompt_id}` 和 `/view` 原生协议，不再启动或依赖 8199。今后接入本地服务时，先以用户明确指定的服务端点为准，再从文档提炼其协议。

- **背景**：此前为 MiniMax H3 接入本地 ComfyUI 视频生成时，需要登记可执行模型目录与工作流变体。
- **现象与根因**：错误地将 H3 理解为固定的单一 I2VA 工作流，只登记了一个粗粒度视频变体，无法表达 T2VA、I2VA、L2VA、FL2VA、Ref2VA 和显式数字人输入。根因是没有先核对本地 `MiniMaxH3Easy` 节点的 `mode`、`keyframe_role` 与 `media_state` 输入合同。
- **处置与预防**：已改为同一真实节点图下的六个显式输入合同，并在选择、上传、节点写入和测试层校验媒体角色；以后登记视频模型前必须先读取并验证本地工作流节点信息，未知模式不得猜测或静默降级。

- **背景**：用户使用已登记的 MiniMax H3 ComfyUI 模型提交 10 秒全参考视频。
- **现象与根因**：模型目录曾把 `durationOptions` 错登记为 `[4]`，并且 H3 全参考媒体同时被送入传统 `LoadImage` 节点数量校验，导致合法时长被拒、参考图节点数与输入不一致。根因是把 H3 的 `MiniMaxH3EasyMediaLoader.media_state` 与旧式图片节点合同混为一谈。
- **处置与预防**：目录现声明 1–15 秒并保留默认 4 秒；H3 变体跳过传统图片节点数量校验，统一通过 `media_state` 传递多媒体；首尾帧与普通参考素材仍保持互斥，提交时必须明确二选一模式。

- **背景**：H3 全参考重试已通过模型、时长和输入模式校验，但 ComfyUI `/prompt` 返回 400。
- **现象与根因**：提交工作流中的 `resolution="720p"`、二阶段 `unet_name="minimax_h3_fl2va_pruned_w4a8_mixed.safetensors"` 和 `tiny_vae="taeh3.safetensors"` 均不在本机 ComfyUI 的实时枚举中。根因是登记工作流时沿用了与本机节点不同的大小写和模型文件名，且没有在提交前用 `/object_info` 实际枚举校验。
- **处置与预防**：已按本机校验错误改为大写分辨率枚举（`720P` 等）、已安装的 `minimax_h3_fl2va_pruned_int8_convrot.safetensors` 以及 `tiny_vae="none"`，并在 API 工作流边界把小写分辨率规范化为大写；后续工作流登记必须以本机节点实时枚举为准。

- **背景**：用户反馈 MiniMax H3 文生视频调用很快显示 `fetch failed`，此前曾把旧 Agents Bridge 的 30 分钟配置解释为当前原生 DSH Web 会话配置。
- **现象与根因**：当前原生 DSH Web 使用独立的 profile；更直接的根因是 H3 的 `runComfyUiTask()` 在拿到 ComfyUI `prompt_id` 后仍同步轮询 `/history`，直到视频完成才返回 taskId，长连接断开时调用方只能看到 `fetch failed`，而 ComfyUI 任务仍在运行。
- **处置与预防**：将 H3 视频改为提交 ComfyUI 后立即返回 `running + promptId`，通过统一任务轮询和画布 reconcile 收取终态；区分 `COMFYUI_POLL_TIMEOUT_MS`（后端轮询预算）与原生 Agent/浏览器连接生命周期，今后不得把旧 Bridge 配置当作原生 DSH 配置的证据。

- **背景**：为验证 `apps/agents` 升级到 `dsh-v0.1.5-rc.2` 后能否正常启动，在临时目录启动 `dsh web` 做冒烟测试，并用 `DSH_HOME` 指向独立沙箱以隔离运行数据。
- **现象与根因**：脚本用 `$HOME = Join-Path $env:TEMP ...` 承载沙箱路径，而 PowerShell 的 `$HOME` 是只读自动变量，赋值失败后该变量仍是用户主目录；紧接着的 `$env:DSH_HOME = $home` 因此把 Harness 的家目录指到 `C:\Users\ASDWERT`，在其下创建了 `profiles/`、`storages/` 与 `.anonymous-user-id` 三个残留条目。我当时只确认了服务能起来、URL 能访问，没有回读实际生效的环境变量与其写入位置。
- **处置与预防**：三个残留条目已在交付说明中如实上报并请用户确认清理。后续凡是用环境变量重定向工具数据目录，必须使用任务专用变量名（如 `$taskHome`），并在启动后回读实际生效路径、确认写入位置落在预期沙箱内，再继续验证；服务可用不等于隔离生效。

- **背景**：在临时克隆中为合并后的 Harness 工作区安装依赖，以生成与目标版本一致的 `pnpm-lock.yaml`。
- **现象与根因**：本机全局 pnpm 是 8.6.5，而该仓库在 `packageManager` 中声明 `pnpm@11.7.0`。直接调用 `pnpm install` 让 8.x 重写了锁文件，产生 7349 行新增、9677 行删除的噪音差异，掩盖了本次真正需要的那一处依赖变更（web-app 新增 `@deepseek-ai/dsh-tools`）。
- **处置与预防**：锁文件已回退并改用 `corepack pnpm@11.7.0 install` 重做，最终差异收敛到 103 行。今后在带 `packageManager` 声明的仓库里安装依赖，必须先按声明版本运行（`corepack pnpm@<version>`），并在安装后检查锁文件差异是否只包含预期变更，不得把工具版本错配造成的全量重写当成正常结果。

- **背景**：升级 `apps/agents` 时发现三个 0.1.x 时期残留的 `session.jsonl` 夹具会让上游 rc.2 的会话格式校验失败，用户批准删除。
- **现象与根因**：我先在用户工作区删除了这三个文件，但临时合并树里同样存在这三个文件（它们来自覆盖层提交），随后用 robocopy 落地合并结果时又被原样拷回，导致已经"修好"的测试在同一轮验证中再次失败。根因是把"在源工作区删除"当作"在落地产物中删除"，没有意识到落地方向是从临时树流向用户树。
- **处置与预防**：已在落地后重新删除并复跑验证（67 个测试文件全绿）。今后做"临时树 → 目标树"的目录级落地时，所有删除动作必须在**落地之后**对目标树执行并复验，不能在落地之前只删除目标树的旧副本。

- **背景**：用户截图反馈文生视频节点提交后立刻失败，节点错误文案为 `data is not defined`。
- **现象与根因**：`apps/web/src/runner/remoteRunner.ts` 的 `runVideoTask` 只从 `ctx` 解构了 `id`、`setNodeStatus`、`appendLog`，却直接引用 `data.workflowCapability`（上一个提交为透传节点能力标识而新增）。该能力标识实际位于 `ctx.data`，函数作用域内不存在 `data`，于是参数对象求值阶段抛出 `ReferenceError`，被同一段 `catch` 捕获后写成节点错误。根因是新增字段透传时未确认变量来源作用域，且此前只有不校验类型的 bundler 构建通过，未做类型检查或函数级运行验证。
- **处置与预防**：已改为读取 `ctx.data.workflowCapability` 并做结构校验后透传；本地用真实函数体加替身依赖复现出同一 `ReferenceError`，修复后同法验证「带值 / 缺省」两种输入，`tsc --noEmit` 在该文件不再报 TS2304。今后在这类过程式大文件里新增字段透传，必须先做类型检查或函数级复现确认变量作用域，不得只凭构建成功判定可用。

- **背景**：把 `apps/agents` 从 Harness `0.1.3-alpha.1` 升级到 `dsh-v0.1.5-rc.2`，先在临时克隆里做三方合并并跑通构建与测试，再用 robocopy 覆盖落地到用户工作区。
- **现象与根因**：我在临时树里验证全绿（67 个测试文件、1117 个用例），据此宣告"落地完成"；但用户工作区里实测全量测试是 **285 个失败**（洁净基线为 66 个），`oxlint` 也从 48 个错误涨到 9679 个。根因有两点：一是落地方式为覆盖式拷贝（`/E /IS /IT`）而非先清空目标，用户树里 880 个不在 rc.2 内的原地生成产物（`src/` 旁与源码同名的 `.js`/`.d.ts`/`.map`）被原样保留，使同一模块被加载两次、触发重复注册与类型重复解析；二是我的"落地校验"只比对了**跟踪文件**的哈希，掩盖了目标树里多出来的非跟踪文件，而真正的行为验证（全量测试）只跑在**临时树**上，没有在真实目标树复跑。
- **处置与预防**：删除那 880 个多余产物后回归基线（66 个失败，与洁净 rc.2 逐条一致；`oxlint` 48 个错误且逐文件分布与升级前完全相同），并确认 build/typecheck/lint/test 均不会再生成它们。今后凡"先在暂存副本验证、再落地到目标树"的改造，必须在**落地的目标树**上重跑同一套行为验证，并把校验范围从"跟踪文件哈希"扩展到"目标树相对参照树的多余/缺失文件清单"；不得用暂存副本的绿灯替代目标树的实测结论。

- **背景**：用户在画布页面反馈原生 Agent 读不到内置画布工具（`tapcanvas_get_current_canvas`、`film_*`）。上一轮原生 Agent 给出的结论是「工具没有挂载到会话」，并把两条推断写成「已核实的事实」：环境里 `TAPCANVAS_CANVAS_MODE=1`、已为本会话创建隔离工作区 `tapcanvas-workspaces/8f8a90240b0aed7c410694ab93602252`。
- **现象与根因**：该隔离目录创建于 2026-09-07，由更早的运行时建立，与本次会话无关；真实失败位置在宿主组合层：`web-runtime` 行内注册画布运行时的 fiber 以 `cannot get property "webServer" without inject` 失败——`ctx.connection.rpc.handle()` 按 Connection 服务自身的上下文解析 `webServer`，而 Web bundle 的 `connection` 行只注入了 `webRuntime`，于是 RPC 通道、`tool:tapcanvas-native` 提示段和全部画布工具都没有注册。该失败是会话级静默的：Host 不中断，浏览器也拿不到报错。上一轮还据一次超时的目录扫描断言「没有构建产物」，实际 `packages/bundle/web-app/lib/index.js` 早已包含这些工具。两次误判的共性是用「源码里存在 / 目录里有残留」代替「运行进程里真的注册成功」，没有回到运行事实；硬证据只有会话日志的 `request/header`：模型实际收到 21 个预设工具、零个画布工具，系统提示里也没有画布提示段。
- **处置与预防**：已给 Web bundle 的 `connection` 行补上 `webServer` 注入，画布 RPC 通道、提示段与 19 个画布/影视工具在各预设会话中恢复可见，并新增 `apps/agents/apps/cli/tests/tapcanvas-canvas-runtime.spec.ts` 守护该挂载（未修复时该用例失败）。今后判定「某工具是否对模型可见」必须以运行中的会话事实为准（会话日志 `request/header`、系统提示段、注册 fiber 的最终状态），不得用源码存在性、遗留工作区目录或超时扫描的推断代替；诊断此类问题应先复现完整 Web 面（含 `webserver`/`connection`/`web-runtime`）并检查是否存在处于 FAILED 状态的 fiber。

- **背景**：为把「下载后识别字幕」独立成 skill，我先核查仓库内既有的 `prepare_subtitles.py` 与 `youtube-storyboard` 的字幕链路。
- **现象与根因**：`.agents/skills/video-downloader/scripts/prepare_subtitles.py` 用 `Path(__file__).resolve().parents[4]` 推断项目根，在该脚本的实际位置（`TapCanvas/.agents/skills/video-downloader/scripts/`）解析出的是 TapCanvas 而不是含 `app/` 的 `F:\aigc\aigc`，导致 `tests/test_prepare_subtitles.py::test_direct_skill_script_exposes_project_services` 真实失败（`ModuleNotFoundError: No module named 'app'`），而 SKILL.md 仍把它描述为可用于说话人分离。同一轮里 `youtube-storyboard/scripts/prepare-youtube.mjs` 的 `repoRoot = .../../../../../..` 也指向 `F:\aigc\aigc`，使 `video-downloader` 脚本路径整体错位（真实报错：`can't open file 'F:\\aigc\\aigc\\.agents\\skills\\video-downloader\\scripts\\download_video.py'`）。根因是两处都用「相对层级常数」推断跨项目根目录，且从未被真实执行验证过。
- **处置与预防**：新 skill `subtitle-transcribe` 改为向上查找含 `app/service/audio_service.py` 的目录来定位项目根，支持 `AIGC_PROJECT_ROOT` 覆盖，找不到即显式失败；`prepare-youtube.mjs` 改为从脚本自身位置推导 `skillsRoot`，并把 Python 解释器解析抽到 `scripts/lib/subtitle-bridge.mjs` 并覆盖测试。今后 skill 脚本引用跨目录资产时，必须由真实文件存在性推导根目录（或由调用方显式传入），并在新增/修改后至少执行一次真实命令验证路径，不得只凭层级常数正确性假设。

- **背景**：用户问「想复刻这种视频的内容形式该怎么做」，我核查仓库内既有的复刻能力 `film-style-replication` skill，确认它能否承接该需求。
- **现象与根因**：该 skill 的 `SKILL.md` 把脚本位置写成 `apps/agents-cli/skills/tapcanvas-film-style-replication/scripts/extract-mp4-frames.mjs`，实测该路径不存在（当时真实位置在 `apps/agents/.agents/skills/film-style-replication/scripts/`，该目录后已改名为 `tapcanvas-film-style-replication` 以纳入版本控制）。同一文件里 `repoRoot = path.resolve(scriptDir, "../../../../..")` 也少了一层，实测解析到 `F:\aigc\aigc\TapCanvas\apps` 而非仓库根；真实执行后 37 张候选帧 PNG 被写进 `apps\.runtime\film-style-replication\`，而正确位置应是仓库根 `.runtime\`。这是 `HE-FL-001` 登记的同一类错误在另一个文件上的再次发生，两处都从未被真实执行验证过。
- **处置与预防**：已把根目录定位抽成 `scripts/lib/repo-root.mjs`，改为向上查找根 `package.json` 的独有 `name: tapcanvas-workspace`，并支持 `TAPCANVAS_REPO_ROOT` 覆盖；`SKILL.md` 修正为真实脚本路径并补充默认产物目录说明。修复过程中发现标记文件必须唯一：初版改认 `pnpm-workspace.yaml`，但 `apps/agents/` 与 `third-party/deepseek-harness/` 各自都有同名文件，向上查找会**提前停在内层工作区**、产物落到 `apps/agents/.runtime`，因此改用根 package.json 的 unique name 作为身份标记。今后为跨目录脚本选根目录标记时，必须先枚举全仓同名文件确认标记唯一，再验证解析结果确实等于期望根目录，不能只验证"没报错"。

- **背景**：用户截图反馈画布内模型 `qwen-image-2.1` 的生成节点执行失败，节点错误文案为「ComfyUI 工作流变体 2 缺少 id/taskKind/referenceImageCount」。此前一轮已为该模型的图编辑变体引入动态参考图区间：源码 `apps/hono-api/src/modules/task/comfyui-workflow.ts`（2026-09-22 15:21）与目录生成脚本 `apps/hono-api/scripts/build-comfyui-catalog.mjs`（2026-09-22 15:05）已改，新目录也在 2026-09-22 15:08 导入数据库。
- **现象与根因**：数据库 `task_results` 里 2026-09-24T02:39:59.232Z（本地 10:39:59）仍有一条失败记录，`raw.failureReason` 正是这句旧文案，说明失败发生在源码修改之后。执行该任务的不是 ts-node 运行的 API，而是 `scripts/dev.mjs` 启动的 BullMQ worker（进程命令行 `node dist/async-image-worker.js`）：该 `dist` 产物构建于 2026-09-12，里面仍是 `if (!id || !taskKind || count === null) throw ... 缺少 id/taskKind/referenceImageCount` 的旧校验，而数据库目录中 `qwen-image-2.1` 的第 2 个变体（`edit`）只声明 `referenceImageRange: { min: 1, max: 16 }`、没有 `referenceImageCount`，于是该模型任何入口的任务都会被这个陈旧 worker 判成配置非法。此前只验证了源码链路（ts-node API 与单元探针），没有核对真正执行任务的进程加载的是哪一份代码，属于用「源码已改」代替「运行进程已生效」。
- **处置与预防**：已重新构建 `apps/hono-api/dist`（产物中旧文案已消失、`referenceImageRange` 支持已入包）并重启 worker；同时把开发态 worker 从 `dist` 切到源码运行——`apps/hono-api/package.json` 新增 `async-image:worker:dev` 与 `async-image:worker:health:dev`，`scripts/dev.mjs` 改用这两条，`dist` 只保留给 docker-compose 与 `pnpm start` 的生产链路，从结构上消除「开发态编译产物滞后于源码」这一类故障。今后凡改动 worker 实际执行的业务代码，验收必须先确认执行该任务的进程运行的是哪一份代码（进程命令行、产物构建时间、源码修改时间三者对齐），再在同一份代码上复现并回归；不得只在源码或单元测试通过时宣告修复完成。

- **背景**：用户在画布对话里追问 `film_audio_gen` 为什么直接返回能力缺口，并明确要求「在报告缺口前，先核实运行时是否真的没有音频节点执行器」。
- **现象与根因**：原生 Agent 侧确实注册了 `film_audio_gen`，但执行体只写了一行 `throw new Error('film_audio_gen 当前没有统一的 TapCanvas 原生音频生成执行器')`；两条 skill（`tapcanvas-film-functions`、`tapcanvas-api`）也把「当前仓库没有统一的原生执行器」写成事实，于是运行时只要被问到配音生成就稳定回报缺口。核实后该结论不成立：`apps/hono-api/src/modules/task/agents-tool-bridge.generate-audio-to-canvas.ts` 的 `generateAudioToCanvas` 早已是完整音频节点执行器（目录校验、MiniMax H3 / 豆包 / ComfyUI 引擎分发、资产登记、画布写入），并且被持久工作流 runner（`execution.video-runner.ts`）真实调用；缺的只是 Agent 侧提交入口与工具面注册。根因是把「工具没暴露」误读成「能力不存在」，再用 skill 文案与占位 `throw` 互相印证，没有回到真实的执行器代码与调用链核实。

- **背景**：用户要求「创建一个故事并制作视频，先生成角色声音」，原生 Agent（小T）在画布对话里串联音频与视频生成，连续暴露四处缺陷。
- **现象与根因**：四处缺陷的共同结构都是「契约与真实能力脱节」。其一，`film_video_composite` 的 `audio_list` 直接抛「当前没有对应的 TapCanvas 原生合成执行器」，但底层 `muxAudioOntoVideo` 早已实现完整（ffmpeg amix/替换、media-worker 优先），且 `concatVideosFromUrls` 已支持本地资产存储；同一条 `muxAudioOntoVideo` 还缺少本地存储分支、硬要求对象存储，在只有本地存储的开发机上必然失败——这与 `film_audio_gen` 是同一类「把未暴露当成不存在」。其二，`film_ask_human` 的实现要求 `option.content`，而 Harness 标准选项契约（`AskUserQuestionOption`、工具描述、`UserQuestionsLike`）都是 `{label, description}`，模型按标准传 `description` 被拒。其三也是最关键的：`film_video_gen.ai_model` 要求「逐字复制系统模型目录返回的精确 modelKey」，但原生会话里既没有任何模型目录工具，也没有 `enabledVideoModels` 或生成偏好上下文，40 个可见工具中无一项能返回模型目录——这是一个**无法满足的契约**，模型只能凭记忆填 `ai_model`，必被 `model_not_configured` 拒绝；对照图片侧之所以能成功，是因为 `film_image_gen` 有显式 `vendor` 通道且有目录解析兜底，视频侧两者都缺。其四，修复过程中我首版把目录工具接到 `loadPublicChatEnabledModelCatalogSummary`，实测才发现该投影只遍历 **new-api 运行时模型**，而本机媒体模型（`minimax-h3`、`krea-2-fast` 等）全在本地 ComfyUI 目录，new-api 只返回 4 个文本模型，于是该目录在本机 image/video/audio 三项全为 0——等于没修。根因同上次：没有先用真实运行数据验证数据源，而是假设了「目录函数」等于「执行器可用的目录」。
- **处置与预防**：已按「按需查询」落地只读目录工具 `film_media_catalog_get`（Hono 侧 `tapcanvas_media_execution_catalog_get`，能力组 `paid_media_generation`，执行语义 `sideEffect: none`，进入 `SAFE_READ_REMOTE_TOOLS`），数据源改为与执行器解析 vendor 时查询的同一张目录表（`model_catalog_models` + `enabled` 过滤），本地执行器模型与系统渠道模型同时可见，并暴露真实物理档位（时长/分辨率/画幅/参考上限/原生音频）。实测本机返回视频 `minimax-h3`（15 档时长、12 档分辨率、`2:3/16:9/9:16`）、音频 `minmax-h3-audio`(engine=minimax-h3) 与 `indextts-2.5`、图片 7 个。同时把 `film_video_composite.audio_list` 接到真实 `muxAudioOntoVideo`（首条替换、其后逐条混音，`audioNodeIds` ≤3 且必须是已有真实 `audioUrl` 的节点），并给 `muxAudioOntoVideo` 补上与 `concatVideosFromUrls` 一致的本地资产存储分支；`film_ask_human` 改为读 Harness 标准 `{label, description}`。同步更新 `apps/hono-api/README.md`「AI 对话架构（当前）」、`tapcanvas-film-functions`/`tapcanvas-api` skill、远端工具面契约与度量基线，并新增作用域契约测试锁住三处回归点。今后接「按目录精确选择模型」这类契约时，必须先用真实运行数据实测该目录在执行所在环境下的非空性（本地执行器与系统渠道是两套来源，不能互相替代），再据此实现工具；同时凡在 agent 侧注册 `throw ... 没有执行器` 的占位实现，必须与底层执行器逐一核对，不得让占位文案与 skill 文档互相印证成「事实」。

- **背景**：用户反馈「现在生成的音色声音怎么都有背景音」——每一次 H3 配音都带一层环境底噪。
- **现象与根因**：问题不在 H3 引擎，而在简易模式模板 `apps/hono-api/src/modules/apiKey/h3-audio-prompt-builder.ts`：三段式与六段式的 `overall_soundscape` 都被**硬编码**成「轻微的室内环境底噪，人声清晰，除台词外没有任何其他人声、杂声或呓语」，同时 `[Shot 1]` 头部也写成「只有环境声淡入」。H3 官方指南（`references/base-en.txt` 4.6 节）规定 `overall_soundscape` 用于描述环境声，且**只有**用户明确要求全程静音时才写 `N/A`——反过来只要正文描述了环境声，模型就会真的铺出音床。于是「简易模式」虽然语义只是「把这段台词念出来」，却对每一次提交都追加了用户从未要求的环境声；模板描述越是泛化（「室内底噪」没有具体声源），模型越是自行发挥补出持续背景音。更关键的是这与本仓库自己的 skill 契约直接冲突：`tapcanvas-h3-audio/SKILL.md` 早已写明「纯语音场景写 `N/A`」，但模板违反了自己仓库的规则。根因是把「为保证段落完整而填一个默认占位」当成了无副作用行为，忽略了声场段落对生成模型是**实质指令**而非元数据。
- **处置与预防**：已把两处 `overall_soundscape` 改为默认 `N/A`（提取为 `SOUNDSCAPE_SILENT` 常量并写明原因），`[Shot 1]` 头部去掉「只有环境声淡入」的表述；需要环境声或配乐时必须来自用户明确诉求并写清具体声源，不再使用「轻微的环境底噪」这类泛化描述。同步更新 `tapcanvas-h3-audio` skill，并新增回归测试锁住「默认无环境声」（断言两段均为 `N/A` 且不含「环境底噪」）。今后凡在生成提示词模板里填写**默认值占位**，必须先确认该字段对模型是实质指令还是纯元数据——声场、配乐、镜头运动、角色数量这类描述性字段一律是实质指令，用户没要求时只能写 `N/A` 或空，不得为了「结构完整」而编造内容；同时模板内容必须与本仓库对应 skill 的契约逐条对齐，出现冲突时以 skill 的创作方法论为准。

- **背景**：用户贴出画布音频节点截图：提示词正文写「约 8.2 秒的纯语音，共 2 句台词」，执行器却报「按台词估算的音频时长为 41.67 秒，超出 1~15 秒范围」，并追问为什么能到 42 秒。
- **现象与根因**：两个数字差近 5 倍，说明提交给执行器的内容与节点里显示的提示词不是同一份。实测复现后定位到两处叠加。其一，节点里保存的 prompt 只有 179 字符、缺首行 `integrated_multimodal_description:`（用户在照抄上一轮总结里的示例时漏掉了该行，示例本身也漏写了这一行，这是我的表述缺陷），于是 `validateH3AudioPromptContract` 判定「不是结构化提示词」；其二，`resolveH3AudioPrompt` 随即按「普通台词」走简易模式模板，把**整段结构化提示词当成一句台词逐行重新打包**——`<d>` 被嵌套成 `<d>...<d>[Chinese] 汤要凉了...</d></d>`，`overall_soundscape:`、`N/A`、`N/A（本段为约 8.2 秒...）` 全被当作台词念出来，台词由 1 句膨胀到 6 句，估算时长精确复现为 **41.67 秒**。根因是「结构损坏」被错误地当成「用户输入的是普通台词」而静默降级重打包，违反仓库的显式失败与零隐式回退原则；由此产生的报错（「请精简台词」）指向错误方向，把提示词结构缺陷误导成台词过长。附带发现简易模式模板还在 `non_diegetic_music` 里写入「N/A（本段为约 X 秒的纯语音，共 N 句台词）」这类**说明性中文**，它同样会被模型当作可朗读内容，是环境声问题之外的第二处非指令噪声。
- **处置与预防**：`resolveH3AudioPrompt` 改为先做结构判定——已出现任一 H3 段落名却缺必需段落时，**显式失败**并列出已声明段落、缺失段落与修复建议（补齐段落，或改为只输入纯台词），不再降级重打包；同时把简易模式模板的 `non_diegetic_music` 收敛为纯 `N/A`，去掉会被朗读的说明性文案。新增回归测试锁住「结构损坏必须显式失败」，并同步 `tapcanvas-h3-audio` skill 补充「纯台词与结构化提示词二选一、手写时必须逐字保留段落名行」。今后凡「模板套用」类逻辑，必须先判定输入属于哪一类，**结构损坏与格式不符必须显式失败**，不得退化成另一种语义继续执行；同时提示词里除台词与音色描述外的任何说明性文字（进度、时长、统计、`N/A` 的附加说明）都可能被模型朗读，模板只能输出纯指令。
