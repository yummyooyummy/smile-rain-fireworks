# 交给 Cursor 的任务清单

核心引擎（`face.ts` / `state.ts` / `particles.ts` / `main.ts`）已经写好并跑通，**不要重构它们**。
下面是次要但必要的活儿，按优先级排。每项单独一个 commit。
动手前先读 `CLAUDE.md`，并用三行复述你要遵守的约束。

---

## P0 · 高级模式抽屉（`src/drawer.ts`，新文件）

**接口已经预留好了**，不要改引擎：

```ts
window.addEventListener('open-drawer', () => { /* 打开抽屉 */ })
const fx = (window as any).__fx        // { getConfig, setConfig, getTier }
fx.getConfig()                          // => EffectConfig
fx.setConfig({ ...fx.getConfig(), rainMax: 0.5 })   // 即时生效
fx.getTier()                            // 'low' | 'mid' | 'high'
```

要求：
- 6 个滑块，元数据直接读 `SLIDERS`（`src/config.ts` 已导出 key/min/max/step），标题文案读 `copy.drawer`。
- 2 个开关：`showGuide`、`showDebug`。
- 1 个按钮：导出 `effect.json` —— 复制到剪贴板 **并且** 触发下载；成功后显示 `copy.drawer.exported`。
- 底部一行只读信息：`copy.drawer.tier` + `fx.getTier()`。
- `?mode=pro` 时自动打开一次。
- 抽屉从右侧滑入，宽度 ≤ 320px，手机上改为从底部滑入、高度 ≤ 60vh；**不得遮挡画面中央的人脸区域**。
- 视觉沿用 `style.css` 里的 CSS 变量，不要引入新色相。

验收：拖任一滑块，特效实时变化；导出的 JSON 用 `?cfg=<base64>` 回灌后参数一致。

---

## P1 · 截图分享

HUD 右下角圆钮旁加一个小按钮：把 `<video>` 当前帧 + `<canvas>` 合成到一张离屏 canvas，
`toBlob` 后走 `navigator.share`（支持时）或触发下载。注意视频要按 `scaleX(-1)` 镜像绘制，
否则合成图和用户看到的左右相反。文案加到 `copy.hud`。

---

## P1 · README.md

结构按顺序写，不要漏：

1. 一句话简介 + Live Demo 链接 + **顶部一段 15 秒演示 GIF**（评审设备摄像头出问题时的兜底）
2. **我如何理解需求**：把模糊需求翻译成可测条件——状态机表格、三张图（状态图/分层图/扩展骨架图，
   源文件放 `docs/`）、以及"微笑/大笑/碰撞体"各自的定义
3. 架构与技术选型理由：为什么不用物理引擎、为什么 Canvas 2D 而不是 WebGL、为什么检测降频但碰撞每帧
4. 性能预算与实测：把 `CLAUDE.md` 的预算表搬过来，附 Chrome Performance 面板截图（放 `docs/`）
5. Edge cases 清单
6. 数据埋点（如果上线我会追踪什么）：触发率、误触发率、平均互动间隔、有/无特效的停留时长、
   帧率 < 30 fps 的会话占比、截图分享率
7. A/B 阈值实验设计：一组用当前阈值，一组 ±0.1，对比触发率与误触发率
8. 已知局限与无障碍：口罩/遮挡、无摄像头的手动路径、多人只跟第一张脸
9. 国际化预留：文案已集中在 `copy.ts` 的 key-value 结构，blendshape 与语言无关
10. v2 路线图：**音效**（本次未做，见下）、多脸碰撞体、手势触发、环境光自适应、笑值累积升级
11. 本地运行：`npm i && npm run dev`

---

## P2 · 视觉打磨（Yuqing 体验后会给具体意见，先不要自作主张大改）

可以先做的确定项：
- 开始页进入时标题与副文案错开 80 ms 的淡入。
- 手动触发圆钮长按时给一个环形进度反馈。
- 引导文字切换时做 200 ms 的交叉淡入，避免文字硬切。

---

## 明确不做（写进 README 的 v2，不要顺手实现）

- **音效**：本次不做。规划保留：默认轻音量、可静音、开始按钮点击时解锁 AudioContext、
  雨声 loop + 烟花 one-shot、音量默认 −12 dB 量级。
- 多人脸碰撞体（`numFaces` 保持 1，官方也只在 1 时做关键点平滑）。
- 头部姿态输入（转头让烟花倾斜）——`Signals` 里预留字段即可，不要实现。
- 环境光自适应。

---

## 常见 AI 幻觉（遇到就记进 `docs/vibe-log.md`）

| 现象 | 纠偏 |
| --- | --- |
| 写出 `new FaceMesh()` / `onResults` | 只用 tasks-vision 1.0.1 的 FaceLandmarker |
| 用了 `mouthOpen` 之类不存在的 blendshape | 对照 CLAUDE.md 的名单逐个核 |
| 粒子缩在左上角 / 左右反了 | 归一化坐标忘乘画布尺寸，或忘了 `1 - x` 镜像 |
| 循环里 `new` 对象、`filter` 数组 | 改回 Float32Array 池 + alive 标志 |
| 主动引入 matter.js / three.js | 拒绝，只做粒子 vs 椭圆 |
| 用 `shadowBlur` 做发光 | 换预渲染贴图 + `lighter` |
| iOS 黑屏 | 缺 `playsinline`，或没在用户点击后才请求摄像头 |
| `timestamp must be monotonically increasing` | `performance.now()` + 前台恢复时 `resetClock()` |

纠偏 prompt 模板：

> 停。当前 `[文件]` 违反 CLAUDE.md 的 `[规则名]`：`[现象 + 数字]`。
> 请改为 `[具体做法]`，不新增依赖。改完给出改动文件与验收方法，
> 并用 Performance 面板数据证明主线程单帧 ≤ 16 ms。
