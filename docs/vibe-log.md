# Vibecoding 日志

记录 AI 在这个项目里犯的错、以及把它掰回来的那句 prompt。
200 字复盘从这里选**真实发生过**的一条，不要编。

格式：现象（带数字）→ 纠偏 prompt 原文 → 结果（带数字）。

---

## 01 · 隐藏的全屏遮罩吃掉了所有点击

**现象**　自动化冒烟测试里点「开始」按钮一直超时，报错说
`<div hidden class="error" id="errorPage"> intercepts pointer events`。
页面看起来完全正常——错误页是隐藏的，但它仍然拦截了整个屏幕的点击。

**原因**　HTML 的 `hidden` 属性靠 UA 样式表的 `display: none` 生效，
而 `.error { display: grid }` 的优先级更高，直接把它盖掉了。
于是 `hidden` 只是「看不见」，不是「不存在」。`.manual`（`display:grid`）、
`.guide`（`display:flex`）有同样的问题。

**修正**　在全局样式里显式压掉：

```css
[hidden] { display: none !important; }
```

**结果**　点击恢复正常。这个 bug 肉眼完全看不出来——页面渲染正确、控制台无报错，
只有真正去点才会暴露。**是自动化冒烟测试而不是肉眼检查发现的。**

---

## 02 · 把唯一的模型来源放在 storage.googleapis.com

**现象**　按官方文档写，模型地址是
`https://storage.googleapis.com/mediapipe-models/.../face_landmarker.task`，
wasm 走 `cdn.jsdelivr.net`。本地开发一切正常。

**问题**　这个 Demo 是交给国内评审打开的。`storage.googleapis.com` 在国内不可达，
jsdelivr 也时好时坏。一旦其中之一失败，整个 Demo 白屏——而这不是代码 bug，
是**架构上把可用性押在了不可控的第三方上**。

**修正思路**　构建前把 wasm 从 `node_modules` 复制到 `public/wasm/`、把模型下载到 `public/models/`，
运行时先探测同源资源，不存在才回退 CDN。见 `scripts/prepare-assets.mjs` 与 `face.ts` 的 `exists()`。

**结果**　运行时零第三方依赖；`?debug=1` 面板的 `assets` 一行会显示 `local` 还是 `cdn`。

---

## 03 ·（待填）

<!-- 接下来在 Cursor 里遇到的错误往这里记。常见候选见 TODO-for-cursor.md 底部的表格。 -->
