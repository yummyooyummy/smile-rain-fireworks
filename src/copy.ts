// 全部 UI 文案集中在此。Yuqing 体验后直接改这里，不要散落到各模块。
// 结构预留 i18n：将来只需把 copy 换成 copy[lang]。

export const copy = {
  start: {
    title: '笑一下，屏幕会开花',
    subtitle: '微笑会下雨，大笑会放烟花。需要打开摄像头，画面只在本机处理，不会上传。',
    button: '开始',
    loading: '正在准备…',
    privacy: '所有画面处理都在你的浏览器里完成',
    // 加载分三段，用户要知道现在卡在哪一段——「正在准备」什么都没说
    stageCamera: '正在请求摄像头权限…',
    stageModel: '正在加载识别模型',
    stageWarmup: '正在启动识别…',
    previewAlt: '玩法预览',
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
    share: '分享截图',
    shareTitle: '笑雨烟花',
  },
  manual: {
    // 手动模式必须自己说出来自己是手动模式，否则用户会以为是识别坏了
    banner: '手动模式 · 表情识别未开启',
    reconnect: '重新连接摄像头',
    connecting: '正在连接…',
  },
  status: {
    noFace: '把脸放进画面里',
    lowLight: '光线有点暗，换个亮一点的地方',
    paused: '已暂停，回到页面后自动继续',
  },
  error: {
    denied: '没有拿到摄像头权限',
    // 「去设置里打开」这句话在不同平台指向完全不同的地方。
    // 说不清路径，用户就会放弃——所以按平台给一条能照着做的路径。
    deniedHint: '允许摄像头之后点重试。也可以用右下角按钮手动触发特效。',
    deniedSteps: {
      iosSafari: '点地址栏左边的「ᴀA」→ 网站设置 → 摄像头 → 改成「允许」。如果那里没有摄像头这一项，去 设置 → Safari 浏览器 → 摄像头 → 允许。',
      iosOther: '点地址栏左边的站点图标 → 权限 → 摄像头 → 允许。iOS 上第三方浏览器还要在 设置 → 该浏览器 → 摄像头 里打开。',
      androidChrome: '点地址栏左边的锁 / 调节图标 → 权限 → 摄像头 → 允许，然后回到这里点重试。',
      desktopChrome: '点地址栏最右边那个被划掉的摄像头图标 → 选「始终允许」→ 点重试。',
      desktopSafari: '菜单栏 Safari 浏览器 → 设置 → 网站 → 摄像头 → 把本站改成「允许」。',
      desktopFirefox: '点地址栏左边被划掉的摄像头图标 → 清除这条阻止设置 → 点重试。',
      generic: '在浏览器地址栏附近的站点设置里把摄像头改成「允许」，然后点重试。',
    },
    unsupported: '这个浏览器不支持摄像头',
    unsupportedHint: '请用最新版 Chrome、Safari 或 Edge 打开。',
    timeout: '摄像头一直没有响应',
    timeoutHint:
      '可能是权限弹窗没弹出来，或者摄像头正被其它程序占用。关掉视频会议、相机类应用后点重试。',
    modelFail: '模型加载失败',
    modelFailHint: '检查网络后点重试。仍可用右下角按钮体验特效。',
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
