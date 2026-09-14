# 笑雨烟花 · 项目约束

浏览器端 AR 表情特效：微笑 → 全屏三层景深下雨；大笑 → 烟花从画面底部升空、在高处炸开，
粒子受重力下落，落到头部椭圆上时分裂成更小的粒子向四周溅开。
**雨与烟花互斥**：大笑时雨在 0.4 s 内淡出、只剩烟花；回到微笑再淡回来。一个状态一个效果。
PC + 手机浏览器直接打开。评审关注三件事：需求定义是否严谨、系统成本（性能/ROI）、AI 协作复盘。

## 技术栈（不可更改）

- Vite + 原生 TypeScript，无框架。**不得引入** React/Vue/three/pixi/matter/cannon 或任何新的运行时依赖。
- 唯一第三方依赖：`@mediapipe/tasks-vision@1.0.1`（精确版本，不要升级或降级）。
- 渲染：Canvas 2D 两层（`#rain` 在人身后、`#fx` 在最前）。物理：自写。部署：Vercel（HTTPS，摄像头必需）。

## 文件职责

| 文件 | 负责 |
| --- | --- |
| `src/main.ts` | 单一 rAF 循环、模块装配、档位自适应、HUD 更新 |
| `src/camera.ts` | getUserMedia，640×480 前置流 |
| `src/face.ts` | FaceLandmarker 封装 + **信号总线**（扩展点） |
| `src/segment.ts` + `segment.worker.ts` | 人像分割（ImageSegmenter，Worker 内同步推理）：CSS mask 遮挡 + 像素级碰撞查表。中/高档开，低档退回椭圆。遮罩极性（哪个值是人）以脸为准：头部椭圆内侧 3×3 采样、≥8/9 一致才算数、连续 3 张才翻；四角判定只是没见过脸时的兜底——四角假设角落是背景，手机贴脸时全是头发肩膀，整张遮罩会来回翻 |
| `src/view.ts` | 视频 → 屏幕坐标映射（object-fit: cover + 镜像），face / segment 共用 |
| `src/state.ts` | 三态状态机 + Laughing 内部爆发事件 + 雨量缓入缓出 |
| `src/particles.ts` | Float32Array 粒子池、雨/烟花弹/火花发射器、椭圆碰撞与分裂、发光贴图 |
| `src/hud.ts` | 开始页（按钮自己变状态，**没有独立错误页**）、引导 + 两根进度条、右上三钮、手动模式、toast、空闲暂停、调试面板 |
| `src/drawer.ts` | 设置面板：**面向玩家**——6 条词化控件（灵敏度 / 雨量 / 烟花大小 / 密度 / 弹跳）+ 3 个配色预设（暖金 / 樱粉 / 薄荷） + 「雨落在身后」开关；「高级设置」折叠区里才是碰撞体、调试、导出配置 |
| `src/config.ts` | EffectConfig、档位表、URL 参数 |
| `src/copy.ts` | 全部 UI 文案（中文），不要在别处写死中文 |

## 架构：信号 → 规则 → 发射器

```
camera → face(信号总线) → state(状态机) → particles(发射器 + 碰撞) → canvas
                                ↑                      ↑
                        EffectConfig（阈值 / 粒子 / 配色）
```

加新玩法只加项，不改旧模块：新输入 → 往 `Signals` 加字段；新玩法 → 往 `state` 加一条规则；
新特效 → 往 `particles` 加一个发射器。**不要为了新功能重构这条链路。**

## 信号总线（face.ts）

`smile = (mouthSmileLeft + mouthSmileRight) / 2`，EMA α=0.35；`jawOpen` 同样平滑。
`head` = **带滚转角的椭圆** `{cx, cy, rx, ry, rot}`（像素坐标，已镜像）。三件事一件都不能少：

1. **整圈 36 个 face oval 点做 PCA 拟合**，不是 4 个点。单点每帧都在抖，
   36 点的中心/主轴/尺寸把独立抖动平均掉。半轴取所有点在两轴上的最大投影。
2. **椭圆跟随头部滚转**，碰撞判定在头部局部坐标系里做。角度收进 (-π/2, π/2] 并对齐上一帧。
3. **沿头部朝上方向外扩 `SKULL_EXTEND`**——face oval 最高点是额头，颅顶和头发不在关键点里；
   外扩后再乘 `FIT_MARGIN` 补上「只扩顶部导致下侧翼轻微漏包」的 0.3%。

时域上分两级：检测频率上用 **One Euro 滤波**（自适应截止频率，只滤 5 个派生标量）去抖，
渲染帧上再做短时间常数插值把 20 Hz 的台阶抹平。
**不要改回固定系数的指数平滑**——那只能在「静止够稳」和「运动不拖影」之间二选一。

改动这段几何或滤波参数后，必须跑 `npm run verify:head` 确认角度误差、包围性、滤波指标仍然达标。
`mouthX/Y` = landmark 13/14 中点。`laugh` 只用于强度映射，不参与状态判断。

## 状态机（state.ts）三态，不许增加状态

| 转移 | 条件 |
| --- | --- |
| Idle → Smiling | smile ≥ `smileEnter`(默认 0.30) 持续 300 ms |
| Smiling → Idle | smile < `smileExit`(0.30) 持续 500 ms |
| Idle / Smiling → Laughing | jawOpen ≥ `laughJaw`(默认 0.15) 且 smile ≥ 微笑退出阈值 持续 150 ms（Idle 可直达；嘴在张开时微笑计时最多暂停 400 ms） |
| Laughing → Smiling | jawOpen < 0.20 持续 400 ms |
| 任意 → Idle | 无脸持续 1000 ms |

持续时长用毫秒而非帧数，因此与帧率无关（注释里标了按 20 Hz 折算的帧数）。

**退出阈值不单独存**，在 `state.ts` 里从进入阈值派生：微笑退出 = `smileEnter × 0.7`，
大笑退出 = `laughJaw × 0.6`。用户怎么拖滑杆迟滞都在，不会出现「进 0.30 / 出 0.30」
这种没有迟滞、临界处反复切换的组合。`config.ts` 里没有 `smileExit` / `laughExitJaw` / `laughSmile`。

**默认值来自真机实测**（2026-09-13）：`smileEnter 0.30`、`laughJaw 0.15`、
`fireworkCount 600`、`burstScale 1.75`、`restitution 0.80`。
`public/effect.json` 必须和 `DEFAULT_CONFIG` 同步——它会覆盖代码里的默认值。

**爆发不是状态，是 Laughing 内部的事件**：进入即三枚齐发 → 每 0.9 s 两枚大的 → 间隙每 0.4 s 补一枚小的。`burstCount` 是计数不是布尔，main 逐枚 launch。
烟花是 `effects.launch(power, scale, head)`——从画面底部升空、到顶点自动炸开，**不是从嘴里喷出来**。
**炸点落在环绕头部的一段椭圆弧上**（正上方最高、两侧渐低），横竖半径分开取，被屏幕封顶时
要扣掉炸开后的展开半径——「炸点在屏幕内」不等于「炸开后在屏幕内」。头贴近顶部时炸点让到两侧。
顶点若落在人身上则继续上升，不在脸前面炸。
离开 Laughing 后 1.5 s 内继续稀疏补发（情绪残留）。

强度映射：雨量 = smoothstep(smileExit, 0.80, smile)，缓入 0.4 s / 缓出 0.8 s（进大笑时 0.4 s 切出）；
Laughing 期间雨量目标恒为 0。进度条是两根：`smileProgress`、`laughProgress`，各自独立、互不清零。
烟花粒子数 = 基准 × scale × (0.55 + 0.45 × jawOpen) × 面积系数（见下）。

**两根进度条的语义**：永远表示「触发进度」，触发之后保持满格（不加文字标签）。大笑退出时按当下笑值决定回 Smiling 还是 Idle，微笑条不会先跳满再掉。
大笑候选真正成立（两个条件都满足、正在计时）时微笑条整行变淡——识别层可以同时有两个信号，
界面只突出当前有效的意图。不把雨量混作进度；一张嘴不压微笑条，正常说话界面不跳。

## 屏幕适配：一个连续系数，不做两套配置

同一组像素参数在 1440 宽桌面上是雨，在 390 宽手机上像牙签；烟花则会炸出屏幕。
但**不做「手机 / 电脑」二分**——平板、折叠屏、缩小的浏览器窗口都落在中间。

- 雨：尺寸系数 `rainK = clamp(短边/820, 0.45, 1)` 乘线宽（下限 1.2 CSS 像素）；
  运动系数 `rainMoveK = clamp(短边/820, 0.7, 1)` 乘速度与漂移。
  **雨丝长度是速度的派生量**（`rlen = 速度 × RAIN_STREAK`，模拟运动模糊），所以它跟着
  `rainMoveK` 走，另有绝对下限 10 px 兜底。线宽与速度不共用系数——一起压就是牙签。
  短边 < 500 时三层 alpha ×1.2（封顶 0.95）。
- 烟花：展开半径由头部四周的实际可用空间决定（`roomX/roomY`），窄屏自然变小；
  粒子数与初速按 `(实际展开 / 参考展开)` 缩放，**粒子数取平方**——面积缩到 0.36
  粒子也要缩到 0.36，否则从「太散」变成「糊成一团」。
- 短边 < 500 记为 `compact`：进大笑只放一枚主烟花（`state.setCompact`），靠节奏不靠数量。

## MediaPipe 硬性规则（违反即重写）

- 只用 `FaceLandmarker.createFromOptions` + `detectForVideo`。
  **禁止** `@mediapipe/face_mesh`、`mp.solutions`、`onResults` 回调写法。
- 选项：`runningMode:"VIDEO"`、`numFaces:1`、`outputFaceBlendshapes:true`、
  `outputFacialTransformationMatrixes:true`、`delegate:"GPU"`（失败自动回退 `"CPU"`）。
- `detectForVideo` 是**同步**调用，不要 `await`；时间戳用 `performance.now()`（毫秒）且严格单调递增，
  页面切回前台要 `resetClock()`。
- blendshape 名只能是：`mouthSmileLeft` `mouthSmileRight` `jawOpen` `mouthClose`
  `cheekSquintLeft/Right` `eyeSquintLeft/Right` `browInnerUp`。
  **不存在** `mouthOpen` / `smile` / `happy`。
- landmark 是 0–1 归一化坐标。前置镜像：`x_px = (1 - x) * width`，`y_px = y * height`。
- 检测每 3 帧一次（≈20 Hz）；**碰撞和渲染每帧**。降频的是检测，不是碰撞，否则会穿模。

## 性能硬性规则

- 粒子数据全部在预分配 `Float32Array`（SoA）里；`update`/`draw` 循环内**禁止**
  `new` / `push` / `splice` / `filter` / 创建闭包 / 拼字符串。
- 单一 `requestAnimationFrame` 循环；video 分辨率 640×480；DPR 上限 2。
- 发光 = 预渲染径向渐变贴图 `drawImage` + `globalCompositeOperation='lighter'`。
- **烟花层不清屏**：每帧用 `destination-out` 压暗 18%，火花的光迹靠余辉自然形成，不画折线拖尾。
  雨和烟花弹在 `#rain` 层（逐帧清屏），烟花弹的彗尾用 14 点位置环手画。
  **禁止 `shadowBlur`**（每颗粒子一次模糊会直接掉到 10 fps）。
- 碰撞只做「粒子 vs 一个带旋转的椭圆」，无粒子间碰撞，O(n)。
- 两层封顶，含义不同：`tier.sparkPerBurst` 限制**单次爆炸**的粒子数，
  `tier.sparkPool` 限制**全屏同时存活**的粒子数（`acquireSpark` 里判）。池满直接丢弃新粒子，
  绝不动态扩容。粒子池按 high 档一次性分配，换档只改上限、不重新 `new`。
- 三档预算（雨上限 / 每发烟花）：low 250/140，mid 500/280，high 800/460。
  启动 2 s 测帧时间定初档；EMA 帧时 > 25 ms 持续 3 s 降档，< 14 ms 持续 5 s 升档；
  单帧 > 80 ms 的尖峰（shader 首次编译）不计入 EMA。
- 预算：主线程单帧 ≤ 16 ms，检测均摊 ≤ 3 ms，粒子更新+绘制 ≤ 6 ms。

## 屏幕分层

```
L0  <video#cam>       镜头，scaleX(-1)
L1  <canvas#rain>     雨（人身后）
L2  <video#camFront>  同一路流，用人像遮罩 mask-image 抠出来的人；分割未开启时 hidden
L3  <canvas#fx>       烟花、水花、碎片（人前面）
L2  #hud      DOM：引导文字+两根进度条（底部居中，文字走完淡出但**进度条常驻**）；
              右上角三钮：隐藏 UI / 设置 / 退出；分享钮（右下，仅摄像头模式）；
              手动触发圆钮（右下 56px，**仅无摄像头时出现**）
L3  抽屉      DOM，默认隐藏
```

## 视觉

暗调暖色，单一视觉世界（不做浅色主题，它永远盖在摄像头画面上）。
烟花调色板固定 4 色：`#F0785A` `#E9B95A` `#FFF3E0` `#6FC3B8`，不得引入其它色相（色相偏移滑块除外）。
雨色 `#BFD4F2`。三层景深的差异必须够大才看得出来（差 20% 等于没有）：
速度 240/520/920 px/s、透明度 0.16/0.4/0.8、线宽 0.8/1.6/2.6、横向漂移 10/24/44 px/s，
生成权重 0.5/0.32/0.18（远层最多）。远层先画、近层后画。

## 碰撞反馈分层

- 雨滴撞头：只在**头部局部坐标系的上半弧**（即头顶，歪头时跟着转）溅出 2–3 颗小水花，
  每滴只溅一次，每帧最多 2 次溅射。
  **雨滴本身不消失**——早期版本让它消失，脸上会出现一个硬边的圆形空洞，非常假。
- 烟花粒子撞头（`sgen === 0`）：**分裂成 3–5 颗更小的粒子沿法线向四周溅开**，母粒子消失。
- 分裂出的碎片（`sgen === 1`）：只反弹 + 闪白 50 ms，**不再分裂**，避免连锁把粒子池打满。
- 任一碰撞都会触发头部椭圆边缘的微光脉冲 120 ms（200 ms 内不重复）。

## URL 参数

`?debug=1` 调试面板 · `?mode=pro` 打开抽屉 · `?mode=clean` 隐藏齿轮与引导 · `?cfg=<base64 json>` 覆盖配置

键盘：**D 随时开关调试面板**（不用改 URL）、1 下雨、2 放烟花。
调试面板打开且没有摄像头时，**指针位置就是一颗虚拟的头**，用来验证碰撞与分裂，不必对着镜头。

## 边界情况

权限拒绝 / 超时 / 模型失败 → **留在开始页**，按钮变成「摄像头未开启，直接开始」+ 分平台的开启路径 + 「重试摄像头」文字链接；
无脸 3 s → 提示；无脸 60 s → 停 rAF，点一下继续；退出钮 → 停摄像头、清粒子、回开始页；
脸太小/置信度低 → 光线提示；页面隐藏 → 暂停循环并重置时间戳；resize/横竖屏 → 重算画布。
**无摄像头也必须能玩**：手动模式下右下角圆钮点一下下雨、长按放烟花。这是评审的后门，正常用户看不到它。

## 工作方式

- 一个任务只改一个模块，单独 commit。
- 写代码前先用 3 行复述本文件里相关的约束。
- 完成后给出：改动文件列表 + 如何验收 + 你认为的性能风险。
- 遇到的 AI 幻觉与纠偏 prompt 记进 `docs/vibe-log.md`（200 字复盘要从里面选真实的一条）。
