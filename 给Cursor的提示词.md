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

## Prompt 1 · 推到 GitHub（**不要装 Homebrew**）

Cursor 可能会建议你装 Homebrew 再装 `gh` CLI。**别装。** 那是为了一条命令去装一整套包管理器，
要输密码、要编译、要十几分钟，而这件事根本不需要命令行。

### 推荐做法：GitHub Desktop（图形界面，五分钟）

1. 打开 <https://desktop.github.com>，下载安装 GitHub Desktop。
2. 打开它，用 GitHub 账号登录——它会自动弹浏览器完成授权，**不需要生成 token、不需要记密码**。
3. 菜单 `File → Add Local Repository`，选 `~/笑雨烟花`。
   它会自动识别出已有的 17 个 commit（不要选 "create a repository"）。
4. 点右上角 `Publish repository`。
   仓库名填 `smile-rain-fireworks`，**把 "Keep this code private" 的勾去掉**（题目要求 Public）。
5. 点 Publish，完成。仓库地址在 `Repository → View on GitHub` 里。

之后每次改完代码，在 GitHub Desktop 里写一句说明、点 Commit、点 Push 就行，不用碰终端。

### 备选：如果你更想用终端

先在浏览器建空仓库：github.com 右上角 `+` → `New repository` →
名字 `smile-rain-fireworks` → 选 **Public** → **不要**勾选任何 "Initialize with..." → Create。

然后把下面这段发给 Cursor（把 `<你的用户名>` 换掉）：

```
在 ~/笑雨烟花 执行：
git remote add origin https://github.com/<你的用户名>/smile-rain-fireworks.git
git push -u origin main

如果 push 要求输入密码，告诉我，不要自己尝试其它方式。
GitHub 已经不接受账号密码了，需要 Personal Access Token 或改用 GitHub Desktop。
不要建议我安装 Homebrew 或 gh CLI——这件事不需要它们。
```

（如果真的卡在密码上，就退回上面的 GitHub Desktop 方案，五分钟解决。）

---

## Prompt 2 · 部署到 Vercel（**也不需要命令行**）

1. 打开 <https://vercel.com>，用 **Continue with GitHub** 登录。
2. `Add New...` → `Project` → 找到 `smile-rain-fireworks` → `Import`。
3. 配置页面基本不用改，确认这几项：
   - Framework Preset：**Vite**
   - Build Command：`npm run build`
   - Output Directory：`dist`
   - Install Command：`npm install`
4. 点 `Deploy`，等一两分钟。

### 部署完必须做的一步验证

在浏览器地址栏依次打开这两个地址（把 `<域名>` 换成 Vercel 给你的地址）：

```
https://<域名>/models/face_landmarker.task     ← 应该开始下载一个 4MB 左右的文件
https://<域名>/wasm/vision_wasm_internal.js    ← 应该显示一大段 JS 代码
```

**两个都不能是 404。** 模型文件来自 Google 的服务器，国内直连不通；
Vercel 的构建机在美国，构建时会自动下载成功，所以线上是自托管的、评审能打开。
但万一那一步失败了，线上就会回退到 Google 的地址——国内评审看到的就是白屏，
而你在有梯子的环境下测试完全正常，根本发现不了。

如果 `models/face_landmarker.task` 是 404，把下面这段发给 Cursor：

```
Vercel 部署后 /models/face_landmarker.task 返回 404，说明构建时
scripts/prepare-assets.mjs 没有成功下载模型。

请查 Vercel 的构建日志，找到 [assets] 开头的那几行，告诉我它报了什么错。
不要自己改代码绕过去，先告诉我原因。
```

最后用手机打开线上地址实测一遍——**这是唯一能证明移动端能跑的方式**，本地 localhost 手机访问不到。

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

## Prompt 7 · 碰撞体可视化开关（新增，可以先做这个）

```
在调参抽屉里加一个「显示碰撞体」开关。

改动范围（只有这三处，不要动别的）：
1. src/config.ts：EffectConfig 加 showCollider: boolean，DEFAULT_CONFIG 里默认 false
2. src/drawer.ts：在现有的 showGuide / showDebug 两个开关旁边加第三个，文案从 copy.drawer 取
3. src/main.ts：绘制那一步，把
     if (cfg.showDebug && head) effects.drawDebugHead(head)
   改成
     if ((cfg.showDebug || cfg.showCollider) && head) effects.drawDebugHead(head)
4. src/copy.ts：drawer 里加 showCollider: '显示碰撞体'

不要碰 particles.ts / face.ts / state.ts 的任何逻辑，drawDebugHead 已经存在且已支持旋转。
验收：勾上开关后，画面上出现跟随头部旋转的青色椭圆；取消勾选后消失；
刷新后跟随 effect.json 的默认值。做完单独 commit。
```

**为什么值得做**：头部碰撞体现在做了很多工作（36 点 PCA 拟合、跟随旋转、覆盖颅顶、
One Euro 去抖），但这些改进**评审是看不见的**——他只会看到粒子撞到头上弹开。
给一个开关让他亲眼看到那个椭圆稳稳地贴着头转，这些工作才算被看见。
录 GIF 时也可以在中间几秒打开它。

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
