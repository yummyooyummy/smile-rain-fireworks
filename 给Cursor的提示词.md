# 给 Cursor 的提示词（按顺序用）

先在 macOS 终端跑一次：

```bash
cd ~/笑雨烟花
rm -rf node_modules      # 之前那份是 Linux 版的二进制，macOS 上用不了
npm install
npm run dev
```

---

## 先说三件小事

### 1. 怎么开调试面板

**现在不用改 URL 了**——在页面上直接按键盘 `D` 就能开关调试面板，再按一次关掉。
面板里还有 `1` 下雨、`2` 放烟花两个快捷键。

如果你想用 URL 的方式：浏览器地址栏把 `http://localhost:5173` 改成
`http://localhost:5173/?debug=1` 回车，就这么简单——`?` 后面的部分就是参数。
同理 `?mode=pro` 打开调参抽屉、`?mode=clean` 进「干净模式」（隐藏所有 UI，录 GIF 时用）。

还有一个新的调试便利：**调试面板打开、且没有摄像头时，鼠标指针的位置就是一颗虚拟的头。**
你可以在手动模式下放一发烟花，然后把鼠标移到粒子落下的地方，直接看碰撞和分裂效果，
不用一直对着镜头笑。

### 2. Cursor 里选哪个模型

**选 Claude Opus 5 High。** 这个项目的活儿是「在一份很严格的约束文档下改多个文件」——
`CLAUDE.md` 里有技术栈禁令、API 名单、性能红线，模型必须能一直记住这些约束不跑偏，
这是强推理模型的强项。Cursor Grok 4.6 High 做单文件小改动也够用，
GPT-5.6 Sol 是 Medium 档，这种活儿不太够。

一个建议：**整个项目坚持用同一个模型**。中途换模型，它会丢掉之前对 `CLAUDE.md` 的理解，
容易把你已经定好的东西推翻重写。

### 3. 每次开新对话，先发这句

```
先读 CLAUDE.md 和 TODO-for-cursor.md。
读完用三行告诉我：这个项目的技术栈禁令是什么、MediaPipe 的硬性规则有哪些、性能红线是什么。
不要写任何代码，等我确认后再动手。
```

它答得对，再往下走。答错就说「重读 CLAUDE.md 的『技术栈』和『性能硬性规则』两节」。

---

## Prompt 1 · 建 GitHub 仓库并推送

```
本地 ~/笑雨烟花 已经是一个 git 仓库，15 个 commit，工作区干净。
请帮我把它推到 GitHub 上一个新的 Public 仓库，仓库名 smile-rain-fireworks。

要求：
1. 先检查我本机有没有装 gh CLI 且已登录（gh auth status）。没装就告诉我怎么装，不要自己乱试。
2. 用 gh repo create 建 Public 仓库并推送 main 分支。
3. 仓库 description 填：浏览器端 AR 表情互动原型 —— 微笑下雨，大笑放烟花，粒子与头部物理碰撞
4. 完成后把仓库地址给我。

不要改动任何源码，不要新建分支，不要动 .gitignore。
```

如果她没装 `gh`，备用方案是手动：去 github.com 建一个空的 Public 仓库（不要勾 README），
然后让 Cursor 执行 `git remote add origin <地址> && git push -u origin main`。

---

## Prompt 2 · 部署到 Vercel

```
把这个项目部署到 Vercel。

要求：
1. 检查有没有装 vercel CLI 并登录。没有就告诉我怎么装。
2. 用 vercel --prod 部署。框架是 Vite，构建命令 npm run build，输出目录 dist。
3. 部署前确认：构建流程会自动跑 npm run prepare:assets（package.json 里的 prebuild），
   它会把 wasm 复制到 public/wasm、把模型下载到 public/models。
4. 部署完成后，用命令行验证这两个地址返回 200：
   <部署域名>/wasm/vision_wasm_internal.js
   <部署域名>/models/face_landmarker.task
   这一步很重要——如果模型是 404，国内网络下打开 Demo 会直接白屏。
5. 把线上地址给我。

不要改源码。如果模型 404，先告诉我，不要自己想别的办法绕过去。
```

**为什么第 4 步重要**：模型文件来自 Google 的服务器，国内直连不通。
Vercel 的构建机在美国能下载成功，所以线上是自托管的、评审能打开。
但如果那一步失败了，线上就会回退到 Google 的地址，国内评审看到的就是白屏。
所以一定要验证。

---

## Prompt 3 · 高级模式抽屉（最重要的一项）

```
按 TODO-for-cursor.md 的 P0 实现高级模式抽屉，新建 src/drawer.ts。

接口已经预留好了，不要改引擎：
  window.addEventListener('open-drawer', () => { 打开抽屉 })
  const fx = (window as any).__fx   // { getConfig, setConfig, getTier }
  fx.setConfig({ ...fx.getConfig(), rainMax: 0.5 })  // 即时生效

具体要求：
- 6 个滑块，直接读 src/config.ts 导出的 SLIDERS 生成，标题读 copy.drawer
- 2 个开关：showGuide、showDebug
- 1 个按钮：导出 effect.json，同时复制到剪贴板和触发下载，成功后显示 copy.drawer.exported
- 底部一行只读：当前性能档位 fx.getTier()
- ?mode=pro 时自动打开一次
- 桌面从右侧滑入宽度不超过 320px；手机从底部滑入高度不超过 60vh
- 不得遮挡画面中央的人脸区域
- 颜色只用 style.css 里已有的 CSS 变量，不要引入新色相
- 中文文案全部从 copy.ts 取，不要在 drawer.ts 里写死

验收：拖任一滑块特效实时变化；导出的 JSON 用 ?cfg=<base64> 回灌后参数一致。
做完单独 commit。
```

---

## Prompt 4 · 截图分享

```
按 TODO-for-cursor.md 的 P1 实现截图分享。

在 HUD 右下角圆钮旁边加一个小按钮：把 <video> 当前帧和 <canvas> 合成到一张离屏 canvas，
toBlob 之后优先走 navigator.share，不支持就触发下载。

关键细节：video 必须按 scaleX(-1) 镜像绘制，否则合成图和用户在屏幕上看到的左右相反。
新文案加到 copy.ts 的 hud 里。没有摄像头时这个按钮隐藏。

做完单独 commit。
```

---

## Prompt 5 · README 补全

```
按 TODO-for-cursor.md 的 P1 把 README.md 补完整。

README 已经有骨架了，不要重写已有内容，只补缺的部分：
1. 顶部加 Live Demo 链接和演示 GIF 的占位（GIF 我自己录，你放好 <img> 标签和路径 docs/demo.gif）
2. 补「性能预算与实测」一节里的实测数据占位表格（我跑完 Chrome Performance 会填）
3. 补三张图的位置：docs/state-machine.png、docs/layers.png、docs/architecture.png
4. 补「目录」一节里新增的 drawer.ts

不要改动已有的「我如何理解这个需求」「技术选型与取舍」两节的文字——那是核心内容。
做完单独 commit。
```

---

## Prompt 6 · 视觉打磨（等我体验完再发）

```
按 TODO-for-cursor.md 的 P2 做视觉打磨，只做这三项，不要自作主张改别的：
1. 开始页进入时标题与副文案错开 80ms 淡入
2. 手动触发圆钮长按时加一个环形进度反馈
3. 引导文字切换时做 200ms 交叉淡入，避免文字硬切

只改 src/style.css 和 src/hud.ts，不要碰 particles.ts / face.ts / state.ts / main.ts。
做完单独 commit。
```

---

## 如果 Cursor 开始乱来

它最可能犯的错和对应的话术：

| 它做了什么 | 你回它 |
| --- | --- |
| 想装 three.js / matter.js / react | 「CLAUDE.md 明确禁止新增运行时依赖。用现有的 Canvas 2D 实现，不要装任何包。」 |
| 去改 particles.ts / face.ts / state.ts | 「这三个文件是核心引擎，不要动。你的任务只允许新建文件或改 hud/style/drawer。」 |
| 写出 `new FaceMesh()` 或 `onResults` | 「这是已废弃的 legacy API。只用 tasks-vision 1.0.1 的 FaceLandmarker + detectForVideo。」 |
| 循环里 `new` 对象或用 `filter` | 「违反 CLAUDE.md 的性能硬性规则：渲染循环内零分配。改用预分配数组 + alive 标志。」 |
| 一次改了七八个文件 | 「回退。一个任务只改一个模块，改完我要能单独 commit。」 |

**每次它犯错，把你原样发过去的那句话记进 `docs/vibe-log.md`。**
第二题的 200 字复盘要从里面选一条真实发生的——编的经不起追问。

---

## 你自己要做的三件事（Cursor 替不了）

1. **调阈值**。按 `D` 开面板，自己笑一遍、家人笑一遍、明暗两种光线各一遍，
   看 `smile` 到多少算在笑、`jawOpen` 到多少算大笑，把 `public/effect.json` 里的数改掉。
   现在的 0.45 / 0.60 / 0.35 是拍出来的初值，一定不准。
2. **改文案和视觉**。文案全在 `src/copy.ts`，颜色全在 `src/style.css` 顶部的 CSS 变量，
   各改一个文件就行，不需要 Cursor。
3. **录 15 秒演示 GIF**。用 `?mode=clean` 进干净模式录，放 README 顶部。
   这是评审设备摄像头出问题时唯一的兜底，别省。
