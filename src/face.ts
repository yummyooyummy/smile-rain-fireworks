// 人脸检测 + 信号总线。
//
// 硬性规则（对应 CLAUDE.md）：
//  - 只用 @mediapipe/tasks-vision 的 FaceLandmarker + detectForVideo，不碰 legacy 的 face_mesh / onResults。
//  - detectForVideo 是同步调用，时间戳用 performance.now()（毫秒）且严格单调递增。
//  - landmark 是 0–1 归一化坐标；前置摄像头镜像后 x_px = (1 - x) * width。
//  - 检测每 N 帧跑一次，渲染帧之间对头部椭圆做指数平滑，碰撞才不会穿模。
//
// 信号总线是整个项目的扩展点：以后加「转头让烟花倾斜」只是往 Signals 里多加一个字段。

import { coverMap, videoToScreenX, videoToScreenY, type CoverMap } from './view'
import { CDN_FACE_MODEL, CDN_WASM_BASE, LOCAL_FACE_MODEL, LOCAL_WASM_BASE, exists } from './assets'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import type { HeadEllipse } from './particles'

export type ModelProgress = (loaded: number, total: number) => void

/**
 * 自己把模型下下来，而不是把 URL 交给 MediaPipe。
 * 唯一的原因是**进度**：交给 MediaPipe 就拿不到下载进度，
 * 4 MB 在慢网下要十几秒，用户区分不了「在下载」和「已经挂了」。
 * 拿到 Uint8Array 后走 baseOptions.modelAssetBuffer，行为完全等价。
 */
async function fetchModel(url: string, onProgress?: ModelProgress): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`model HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body) return new Uint8Array(await res.arrayBuffer())

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress?.(loaded, total)
  }
  const out = new Uint8Array(loaded)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 允许使用的 blendshape 名单，写死防止拼错 */
const BS = {
  smileL: 'mouthSmileLeft',
  smileR: 'mouthSmileRight',
  jaw: 'jawOpen',
  squintL: 'eyeSquintLeft',
  squintR: 'eyeSquintRight',
} as const

// 额顶与下巴：用来给头部长轴定「哪边朝上」；嘴：上下内唇取中点
const LM_TOP = 10
const LM_CHIN = 152
const LM_LIP_UP = 13
const LM_LIP_DOWN = 14

const EMA = 0.35
const HEAD_SMOOTH_K = 18 // 渲染帧之间的插值强度，越大跟得越紧

/**
 * face oval 的 36 个轮廓点（MediaPipe FACEMESH_FACE_OVAL 的环）。
 * 用整圈轮廓而不是 4 个点来拟合，是为了**降噪**：单个 landmark 每帧都在抖，
 * 36 个点求出来的中心/主轴/尺寸把这些独立抖动平均掉了。
 */
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
  148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
] as const

/**
 * 颅顶补偿：face oval 的最高点是额头，**头顶的骨头和头发不在关键点里**。
 * 沿头部朝上方向按 oval 半高的这个比例往外扩。
 * 数值是对着 ?debug=1 的碰撞体轮廓调出来的，不同发型可以在这里改。
 */
const SKULL_EXTEND = 0.3
/** 左右也留一点头发的余量 */
const HAIR_WIDEN = 1.06
/**
 * 拟合安全裕度。只把顶部外扩、同时把中心上移，会让椭圆在**下侧翼**略微收进轮廓内侧
 * （数值验证：最坏处 0.3%，约 0.1px）。加 2% 让碰撞体可证明地包住整圈轮廓。
 */
const FIT_MARGIN = 1.02

/**
 * One Euro 滤波器（Casiez et al. 2012）。
 *
 * 为什么不用固定系数的指数平滑：固定系数只能在「静止时够稳」和「运动时不拖影」之间二选一。
 * 系数调小，人不动时碰撞体还在抖；系数调大，人一动碰撞体就黏在后面。
 * One Euro 让截止频率跟着速度自适应——静止时重滤波，快速运动时低延迟，
 * 每个通道只有三个标量状态，O(1)。
 *
 * 关键工程细节：只对**派生出来的 5 个标量**（中心 x/y、两个半轴、旋转角）滤波，
 * 不对 72 个原始坐标滤波——同样的效果，1/14 的开销。
 */
class OneEuro {
  private xPrev = NaN
  private dxPrev = 0

  constructor(
    private minCutoff: number,
    private beta: number,
    private dCutoff = 1,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(x: number, dt: number): number {
    if (!Number.isFinite(this.xPrev) || dt <= 0) {
      this.xPrev = x
      this.dxPrev = 0
      return x
    }
    const dx = (x - this.xPrev) / dt
    const aD = OneEuro.alpha(this.dCutoff, dt)
    const dxHat = aD * dx + (1 - aD) * this.dxPrev
    this.dxPrev = dxHat
    // 速度越快，截止频率越高 = 滤得越轻 = 延迟越低
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat)
    const a = OneEuro.alpha(cutoff, dt)
    const xHat = a * x + (1 - a) * this.xPrev
    this.xPrev = xHat
    return xHat
  }

  get last(): number {
    return this.xPrev
  }

  reset(): void {
    this.xPrev = NaN
    this.dxPrev = 0
  }
}

// beta 的单位跟着被滤的量走：像素通道的速度是 px/s，角度通道是 rad/s，
// 所以两者的 beta 差好几个数量级。这些值是对着调试面板调出来的。
const EURO_POS = () => new OneEuro(1.2, 0.015) // 中心与半轴（像素）
const EURO_ROT = () => new OneEuro(1.0, 3.0) // 旋转角（弧度）

export interface Signals {
  smile: number
  jawOpen: number
  squint: number
  /** 复合强度，只用于映射粒子量，不参与状态判断 */
  laugh: number
  head: HeadEllipse | null
  mouthX: number
  mouthY: number
  faceOk: boolean
  /** 检测置信度低（用于「光线太暗」提示） */
  lowConfidence: boolean
}

export class FaceTracker {
  private cover: CoverMap = { scale: 1, offX: 0, offY: 0 }
  private landmarker: FaceLandmarker | null = null
  private lastTs = 0
  private bsIndex: Record<keyof typeof BS, number> | null = null

  private raw = { smile: 0, jaw: 0, squint: 0 }
  private sig: Signals = {
    smile: 0,
    jawOpen: 0,
    squint: 0,
    laugh: 0,
    head: null,
    mouthX: 0,
    mouthY: 0,
    faceOk: false,
    lowConfidence: false,
  }

  private targetHead: HeadEllipse = { cx: 0, cy: 0, rx: 0, ry: 0, rot: 0 }
  private hasTarget = false
  private smoothHead: HeadEllipse = { cx: 0, cy: 0, rx: 0, ry: 0, rot: 0 }
  private targetMouthX = 0
  private targetMouthY = 0
  private missFrames = 0

  // 轮廓点缓冲，预分配，detect 里零分配
  private ovalX = new Float32Array(FACE_OVAL.length)
  private ovalY = new Float32Array(FACE_OVAL.length)

  // 5 个派生标量各一个 One Euro
  private fCx = EURO_POS()
  private fCy = EURO_POS()
  private fRx = EURO_POS()
  private fRy = EURO_POS()
  private fRot = EURO_ROT()
  private lastDetectTs = 0

  /** 上一次检测耗时（ms），给调试面板看 */
  lastDetectMs = 0
  delegate: 'GPU' | 'CPU' = 'GPU'

  /** 资源来源，写进调试面板方便排查「为什么加载不出来」 */
  assetSource: 'local' | 'cdn' = 'local'

  async init(onProgress?: ModelProgress): Promise<void> {
    const localOk = await exists(`${LOCAL_WASM_BASE}/vision_wasm_internal.js`)
    const wasmBase = localOk ? LOCAL_WASM_BASE : CDN_WASM_BASE
    const modelUrl = (await exists(LOCAL_FACE_MODEL)) ? LOCAL_FACE_MODEL : CDN_FACE_MODEL
    this.assetSource = localOk ? 'local' : 'cdn'
    const vision = await FilesetResolver.forVisionTasks(wasmBase)
    const buf = await fetchModel(modelUrl, onProgress)

    const opts = (delegate: 'GPU' | 'CPU') =>
      ({
        // 每次都给一份拷贝：MediaPipe 会接管这块 buffer，回退重试时原来那份可能已经不可用
        baseOptions: { modelAssetBuffer: buf.slice(), delegate },
        runningMode: 'VIDEO' as const,
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      }) as const

    try {
      this.landmarker = await FaceLandmarker.createFromOptions(vision, opts('GPU'))
      this.delegate = 'GPU'
    } catch {
      // GPU delegate 在部分 iOS / 老安卓上会失败，回退 CPU 而不是让页面挂掉
      this.landmarker = await FaceLandmarker.createFromOptions(vision, opts('CPU'))
      this.delegate = 'CPU'
    }
  }

  get ready(): boolean {
    return this.landmarker !== null
  }

  /** 页面切回前台时重置时间戳基准，避免 "timestamp must be monotonically increasing" */
  resetClock(): void {
    this.lastTs = 0
    this.lastDetectTs = 0
  }

  /** 丢失人脸后清空滤波器状态，下次出现时立即吸附而不是从旧位置慢慢飘过去 */
  private resetFilters(): void {
    this.fCx.reset()
    this.fCy.reset()
    this.fRx.reset()
    this.fRy.reset()
    this.fRot.reset()
    this.lastDetectTs = 0
    this.smoothHead.rx = 0
  }

  /** 当前头部滚转角（度），给调试面板看 */
  get headRotDeg(): number {
    return (this.smoothHead.rot * 180) / Math.PI
  }

  /**
   * 跑一次检测。w/h 是画布的 CSS 尺寸，用于把归一化坐标换成像素。
   * 调用方负责降频（每 N 帧一次）。
   */
  detect(video: HTMLVideoElement, w: number, h: number): void {
    if (!this.landmarker || video.readyState < 2) return
    let ts = performance.now()
    if (ts <= this.lastTs) ts = this.lastTs + 1
    this.lastTs = ts

    const t0 = performance.now()
    const res = this.landmarker.detectForVideo(video, ts)
    this.lastDetectMs = performance.now() - t0

    const lms = res.faceLandmarks?.[0]
    const shapes = res.faceBlendshapes?.[0]?.categories

    if (!lms || !shapes) {
      this.missFrames++
      if (this.missFrames > 3) {
        this.sig.faceOk = false
        this.hasTarget = false
        this.resetFilters()
        this.raw.smile = 0
        this.raw.jaw = 0
        this.raw.squint = 0
      }
      return
    }
    this.missFrames = 0
    this.sig.faceOk = true

    if (!this.bsIndex) {
      const find = (name: string) => shapes.findIndex((c) => c.categoryName === name)
      this.bsIndex = {
        smileL: find(BS.smileL),
        smileR: find(BS.smileR),
        jaw: find(BS.jaw),
        squintL: find(BS.squintL),
        squintR: find(BS.squintR),
      }
    }
    const bi = this.bsIndex
    const score = (i: number) => (i >= 0 ? shapes[i].score : 0)

    this.raw.smile = (score(bi.smileL) + score(bi.smileR)) / 2
    this.raw.jaw = score(bi.jaw)
    this.raw.squint = (score(bi.squintL) + score(bi.squintR)) / 2

    // 镜像 + object-fit: cover 换算：手机竖屏上视频按高度放大、左右裁掉一大截，
    // 直接乘屏幕宽高会把碰撞体横向压扁（见 view.ts）。
    const cm = coverMap(video.videoWidth || 640, video.videoHeight || 480, w, h, this.cover)
    const vw = video.videoWidth || 640
    const vh = video.videoHeight || 480
    const px = (i: number) => videoToScreenX(lms[i].x * vw, cm, w)
    const py = (i: number) => videoToScreenY(lms[i].y * vh, cm)

    // ---------- 头部碰撞体 ----------
    //
    // 三件必须处理的事，少一件「碰撞」就只是看起来像碰撞：
    //  1. 用整圈 36 个轮廓点做 PCA 拟合，而不是 4 个点。单点每帧都在抖，
    //     36 个点求出来的中心/主轴/尺寸把独立抖动平均掉了。
    //  2. 椭圆必须带滚转角。人一歪头，脸转了椭圆没转，判定整个偏掉。
    //  3. face oval 的最高点是额头——颅顶和头发不在关键点里，必须沿头部朝上方向外扩，
    //     否则粒子会穿过头发才碰到额头。
    const N = FACE_OVAL.length
    const ox = this.ovalX
    const oy = this.ovalY
    let mx = 0
    let my = 0
    for (let i = 0; i < N; i++) {
      const x = px(FACE_OVAL[i])
      const y = py(FACE_OVAL[i])
      ox[i] = x
      oy[i] = y
      mx += x
      my += y
    }
    mx /= N
    my /= N

    // PCA：2×2 协方差矩阵的主特征向量方向即头部长轴
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (let i = 0; i < N; i++) {
      const dx = ox[i] - mx
      const dy = oy[i] - my
      sxx += dx * dx
      syy += dy * dy
      sxy += dx * dy
    }
    // 长轴角度（2×2 对称阵特征向量的闭式解）
    let major = 0.5 * Math.atan2(2 * sxy, sxx - syy)

    // 让长轴指向「头顶」而不是下巴：用 152→10 这条向量定方向
    const upRefX = px(LM_TOP) - px(LM_CHIN)
    const upRefY = py(LM_TOP) - py(LM_CHIN)
    if (Math.cos(major) * upRefX + Math.sin(major) * upRefY < 0) major += Math.PI

    const upX = Math.cos(major)
    const upY = Math.sin(major)
    // 「向右」轴与长轴垂直；HeadEllipse.rot 存的就是它
    const rightX = -upY
    const rightY = upX

    // 半轴 = 所有轮廓点在该轴上的最大投影，保证椭圆真的把轮廓包住
    let halfUp = 0
    let halfRight = 0
    for (let i = 0; i < N; i++) {
      const dx = ox[i] - mx
      const dy = oy[i] - my
      const pu = Math.abs(dx * upX + dy * upY)
      const pr = Math.abs(dx * rightX + dy * rightY)
      if (pu > halfUp) halfUp = pu
      if (pr > halfRight) halfRight = pr
    }

    // 颅顶补偿：只往上扩，所以中心也要跟着上移一半
    const grow = SKULL_EXTEND * halfUp
    const rawCx = mx + upX * (grow / 2)
    const rawCy = my + upY * (grow / 2)
    const rawRy = Math.max((halfUp + grow / 2) * FIT_MARGIN, 12)
    const rawRx = Math.max(halfRight * HAIR_WIDEN, 12)

    // 椭圆是 π 周期的，把角度收进 (-π/2, π/2] 再滤波，避免在 ±π 处翻转
    let rawRot = Math.atan2(rightY, rightX)
    while (rawRot > Math.PI / 2) rawRot -= Math.PI
    while (rawRot <= -Math.PI / 2) rawRot += Math.PI
    // 再对齐到上一帧，防止在 ±π/2 边界来回跳
    const prevRot = this.fRot.last
    if (Number.isFinite(prevRot)) {
      while (rawRot - prevRot > Math.PI / 2) rawRot -= Math.PI
      while (rawRot - prevRot < -Math.PI / 2) rawRot += Math.PI
    }

    // One Euro：静止时重滤波去抖，快速运动时低延迟
    const dtDet = this.lastDetectTs ? (ts - this.lastDetectTs) / 1000 : 0
    this.lastDetectTs = ts
    const t = this.targetHead
    t.cx = this.fCx.filter(rawCx, dtDet)
    t.cy = this.fCy.filter(rawCy, dtDet)
    t.rx = this.fRx.filter(rawRx, dtDet)
    t.ry = this.fRy.filter(rawRy, dtDet)
    t.rot = this.fRot.filter(rawRot, dtDet)
    this.hasTarget = true

    this.targetMouthX = (px(LM_LIP_UP) + px(LM_LIP_DOWN)) / 2
    this.targetMouthY = (py(LM_LIP_UP) + py(LM_LIP_DOWN)) / 2

    // 脸太小 = 离得太远或检测不稳，当成低置信度
    this.sig.lowConfidence = t.rx < w * 0.06
  }

  /** 每个渲染帧调用：做 EMA 平滑与头部插值，返回当前信号 */
  sample(dt: number): Signals {
    this.sig.smile += (this.raw.smile - this.sig.smile) * EMA
    this.sig.jawOpen += (this.raw.jaw - this.sig.jawOpen) * EMA
    this.sig.squint += (this.raw.squint - this.sig.squint) * EMA
    this.sig.laugh = this.sig.smile * 0.6 + this.sig.jawOpen * 0.4

    if (this.hasTarget) {
      // 第二级平滑：One Euro 已经在检测频率上去过抖，这里只负责把 20 Hz 的
      // 台阶抹成 60 Hz 的连续运动，时间常数很短，几乎不引入额外延迟。
      const k = 1 - Math.exp(-HEAD_SMOOTH_K * dt)
      const s = this.smoothHead
      const tgt = this.targetHead
      if (s.rx === 0) {
        s.cx = tgt.cx
        s.cy = tgt.cy
        s.rx = tgt.rx
        s.ry = tgt.ry
        s.rot = tgt.rot
      } else {
        s.cx += (tgt.cx - s.cx) * k
        s.cy += (tgt.cy - s.cy) * k
        s.rx += (tgt.rx - s.rx) * k
        s.ry += (tgt.ry - s.ry) * k
        // 角度走最短弧，直接插值会在边界处整圈翻转
        let d = tgt.rot - s.rot
        while (d > Math.PI) d -= Math.PI * 2
        while (d < -Math.PI) d += Math.PI * 2
        s.rot += d * k
      }
      this.sig.head = s
      this.sig.mouthX += (this.targetMouthX - this.sig.mouthX) * k
      this.sig.mouthY += (this.targetMouthY - this.sig.mouthY) * k
    } else {
      this.sig.head = null
      this.smoothHead.rx = 0
    }
    return this.sig
  }

  close(): void {
    this.landmarker?.close()
    this.landmarker = null
  }
}
