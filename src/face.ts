// 人脸检测 + 信号总线。
//
// 硬性规则（对应 CLAUDE.md）：
//  - 只用 @mediapipe/tasks-vision 的 FaceLandmarker + detectForVideo，不碰 legacy 的 face_mesh / onResults。
//  - detectForVideo 是同步调用，时间戳用 performance.now()（毫秒）且严格单调递增。
//  - landmark 是 0–1 归一化坐标；前置摄像头镜像后 x_px = (1 - x) * width。
//  - 检测每 N 帧跑一次，渲染帧之间对头部椭圆做指数平滑，碰撞才不会穿模。
//
// 信号总线是整个项目的扩展点：以后加「转头让烟花倾斜」只是往 Signals 里多加一个字段。

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import type { HeadEllipse } from './particles'

// 资源优先走同源（scripts/prepare-assets.mjs 在构建前准备好），
// 只有本地不存在时才回退官方 CDN——国内网络下 storage.googleapis.com 不可达，
// 把它当唯一来源会让整个 Demo 白屏。
const LOCAL_WASM_BASE = 'wasm'
const LOCAL_MODEL = 'models/face_landmarker.task'
const CDN_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

/** 允许使用的 blendshape 名单，写死防止拼错 */
const BS = {
  smileL: 'mouthSmileLeft',
  smileR: 'mouthSmileRight',
  jaw: 'jawOpen',
  squintL: 'eyeSquintLeft',
  squintR: 'eyeSquintRight',
} as const

// 脸部轮廓关键点：额顶 / 下巴 / 左右脸颊边缘；嘴：上下内唇
const LM_TOP = 10
const LM_CHIN = 152
const LM_LEFT = 234
const LM_RIGHT = 454
const LM_LIP_UP = 13
const LM_LIP_DOWN = 14

const EMA = 0.35
const HEAD_SMOOTH_K = 18 // 越大跟得越紧

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

  private targetHead: HeadEllipse | null = null
  private smoothHead: HeadEllipse = { cx: 0, cy: 0, rx: 0, ry: 0 }
  private targetMouthX = 0
  private targetMouthY = 0
  private missFrames = 0

  /** 上一次检测耗时（ms），给调试面板看 */
  lastDetectMs = 0
  delegate: 'GPU' | 'CPU' = 'GPU'

  /** 资源来源，写进调试面板方便排查「为什么加载不出来」 */
  assetSource: 'local' | 'cdn' = 'local'

  async init(): Promise<void> {
    const localOk = await exists(`${LOCAL_WASM_BASE}/vision_wasm_internal.js`)
    const wasmBase = localOk ? LOCAL_WASM_BASE : CDN_WASM_BASE
    const modelUrl = (await exists(LOCAL_MODEL)) ? LOCAL_MODEL : CDN_MODEL
    this.assetSource = localOk ? 'local' : 'cdn'
    const vision = await FilesetResolver.forVisionTasks(wasmBase)
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })
      this.delegate = 'GPU'
    } catch {
      // GPU delegate 在部分 iOS / 老安卓上会失败，回退 CPU 而不是让页面挂掉
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })
      this.delegate = 'CPU'
    }
  }

  get ready(): boolean {
    return this.landmarker !== null
  }

  /** 页面切回前台时重置时间戳基准，避免 "timestamp must be monotonically increasing" */
  resetClock(): void {
    this.lastTs = 0
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
        this.targetHead = null
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

    // 镜像换算：前置摄像头画面左右翻转，粒子必须画在用户看到的位置
    const px = (i: number) => (1 - lms[i].x) * w
    const py = (i: number) => lms[i].y * h

    const xl = px(LM_LEFT)
    const xr = px(LM_RIGHT)
    const yt = py(LM_TOP)
    const yb = py(LM_CHIN)
    const cx = (xl + xr) / 2
    const cy = (yt + yb) / 2
    const rx = (Math.abs(xr - xl) / 2) * 1.12
    const ry = (Math.abs(yb - yt) / 2) * 1.08

    this.targetHead = { cx, cy, rx: Math.max(rx, 12), ry: Math.max(ry, 12) }
    this.targetMouthX = (px(LM_LIP_UP) + px(LM_LIP_DOWN)) / 2
    this.targetMouthY = (py(LM_LIP_UP) + py(LM_LIP_DOWN)) / 2

    // 脸太小 = 离得太远或检测不稳，当成低置信度
    this.sig.lowConfidence = rx < w * 0.06
  }

  /** 每个渲染帧调用：做 EMA 平滑与头部插值，返回当前信号 */
  sample(dt: number): Signals {
    this.sig.smile += (this.raw.smile - this.sig.smile) * EMA
    this.sig.jawOpen += (this.raw.jaw - this.sig.jawOpen) * EMA
    this.sig.squint += (this.raw.squint - this.sig.squint) * EMA
    this.sig.laugh = this.sig.smile * 0.6 + this.sig.jawOpen * 0.4

    if (this.targetHead) {
      const k = 1 - Math.exp(-HEAD_SMOOTH_K * dt)
      const s = this.smoothHead
      if (s.rx === 0) {
        s.cx = this.targetHead.cx
        s.cy = this.targetHead.cy
        s.rx = this.targetHead.rx
        s.ry = this.targetHead.ry
      } else {
        s.cx += (this.targetHead.cx - s.cx) * k
        s.cy += (this.targetHead.cy - s.cy) * k
        s.rx += (this.targetHead.rx - s.rx) * k
        s.ry += (this.targetHead.ry - s.ry) * k
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
