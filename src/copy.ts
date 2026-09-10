// 全部 UI 文案集中在此。Yuqing 体验后直接改这里，不要散落到各模块。
// 结构预留 i18n：将来只需把 copy 换成 copy[lang]。

export const copy = {
  start: {
    title: '笑一下，屏幕会开花',
    subtitle: '微笑会下雨，大笑会放烟花。需要打开摄像头，画面只在本机处理，不会上传。',
    button: '开始',
    loading: '正在准备摄像头与模型…',
    privacy: '所有画面处理都在你的浏览器里完成',
  },
  guide: {
    step1: '对着镜头微笑，雨就会落下来',
    step2: '再张开嘴大笑试试',
    step3: '摆摆头，让烟花撞到你',
    done: '玩法解锁了，尽情笑吧',
  },
  hud: {
    manualHint: '点一下下雨 · 长按放烟花',
    gear: '调参',
  },
  status: {
    noFace: '把脸放进画面里',
    lowLight: '光线有点暗，换个亮一点的地方',
    paused: '已暂停，回到页面后自动继续',
  },
  error: {
    denied: '没有拿到摄像头权限',
    deniedHint:
      '在浏览器地址栏左侧的站点设置里允许摄像头，然后刷新页面。也可以用右下角按钮手动触发特效。',
    unsupported: '这个浏览器不支持摄像头',
    unsupportedHint: '请用最新版 Chrome、Safari 或 Edge 打开。',
    modelFail: '模型加载失败',
    modelFailHint: '检查网络后刷新。仍可用右下角按钮体验特效。',
    retry: '重试',
    fallback: '先用手动模式体验',
  },
  drawer: {
    title: '特效参数',
    smileThreshold: '微笑阈值',
    laughThreshold: '大笑阈值',
    rainMax: '雨量上限',
    fireworkCount: '烟花粒子数',
    restitution: '碰撞弹性',
    hueShift: '色调偏移',
    showGuide: '显示提示与进度条',
    showDebug: '显示调试数据',
    exportJson: '导出 effect.json',
    exported: '已复制到剪贴板',
    reset: '恢复默认',
    tier: '当前档位',
  },
} as const
