# 从这里开始

代码已经在 `~/笑雨烟花`，git 仓库已初始化，10 个 commit。

## 第一步：跑起来（macOS 终端）

```bash
cd ~/笑雨烟花
npm install
npm run dev
```

浏览器打开终端里显示的地址（`http://localhost:5173`），点「开始」，允许摄像头。

想看数据就加参数：`http://localhost:5173/?debug=1`
左上角会显示 smile / jawOpen 的实时数值、当前状态、帧率、检测耗时、粒子数、性能档位，
并且键盘 1 = 下雨、2 = 烟花。**调阈值之前先看这个面板里你笑的时候数值是多少。**

## 关于模型文件

`npm run dev` 之前会自动跑 `scripts/prepare-assets.mjs`，它做两件事：
把 MediaPipe 的 wasm 从 `node_modules` 复制到 `public/wasm/`，
把模型下载到 `public/models/face_landmarker.task`。

模型来自 `storage.googleapis.com`，**国内直连不通**，你大概率需要挂梯子跑一次
（只需成功一次，文件会留在本地）。如果没下下来也不会中断——运行时会自动回退到官方 CDN，
`?debug=1` 面板的 `assets` 那一行会显示 `local` 还是 `cdn`。

**这件事很重要**：交付时评审多半在国内网络打开 Demo。如果模型只能从 Google 拉，
他那边直接白屏。所以部署到 Vercel 之前，一定确认 `public/models/face_landmarker.task` 存在
（Vercel 的构建机在美国，也会自动下载成功）。

## 已经做好的

| 模块 | 状态 |
| --- | --- |
| 粒子引擎（Float32Array 池、三层景深雨、烟花、椭圆碰撞、碰撞反馈分层） | ✅ 冒烟测试通过 |
| 人脸检测 + 信号总线（EMA 平滑、镜像换算、头部椭圆插值、GPU→CPU 回退） | ✅ 已实现，待真人验证 |
| 三态状态机（迟滞、防抖、爆发事件、情绪残留） | ✅ |
| 主循环（检测降频 20Hz、碰撞每帧、三档性能自适应） | ✅ |
| HUD（开始页、三步引导 + 进度条、手动触发、错误兜底、调试面板） | ✅ 结构可用，视觉待你打磨 |
| 同源 wasm/模型 + CDN 兜底 | ✅ |
| README、CLAUDE.md、vibe-log | ✅ 待补 Demo 链接、GIF、性能截图 |
| 高级模式抽屉 | ⬜ 交给 Cursor（接口已预留） |
| 截图分享 | ⬜ 交给 Cursor |

## 交给 Cursor 的活儿

打开 Cursor，让它读 `TODO-for-cursor.md`，按 P0 → P1 → P2 顺序做。
里面写清了抽屉要接的接口（`window.__fx`）、不许碰的模块、以及不要顺手实现的东西。
`CLAUDE.md` 是给它的项目约束，每次动手前让它先复述相关条款。

**核心引擎不要让它重构。** 它可以加文件，不要改 `particles.ts` / `face.ts` / `state.ts` 的架构。

## 你自己要做的三件事

1. **调阈值**。开 `?debug=1`，自己笑一遍、家人笑一遍、明暗两种光线各一遍，
   看 smile 到多少算「在笑」、jawOpen 到多少算「大笑」，把 `public/effect.json` 里的数改掉。
   现在的 0.45 / 0.60 / 0.35 是初值，一定不准。
2. **体验完给 UI 意见**。文案全在 `src/copy.ts`，改那一个文件就行。
   视觉在 `src/style.css`，颜色都是 CSS 变量。
3. **录一段 15 秒的演示 GIF** 放 README 顶部。这是评审设备摄像头出问题时唯一的兜底。

## 部署

GitHub 建 Public 仓库 → `git remote add origin ...` → `git push -u origin main` →
Vercel 导入该仓库，框架选 Vite，其余默认。构建命令会自动跑 `prebuild` 准备资源。

## 已经踩过的两个坑（已写进 docs/vibe-log.md）

1. `hidden` 属性被 CSS 的 `display:grid` 盖掉，隐藏的全屏错误页仍然拦截所有点击——
   页面看起来完全正常，只有真去点才发现。是自动化冒烟测试发现的，不是肉眼。
2. 把模型唯一来源放在 `storage.googleapis.com`，本地开发正常但交付会白屏。
   这不是代码 bug，是架构上把可用性押在了不可控的第三方上。

这两条都可以作为 200 字复盘的候选，但**建议留给你在 Cursor 里真实遇到的那一条**——
复盘要能经得起追问。
