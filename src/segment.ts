// 人像分割：一张「这个像素是不是人」的遮罩，同时做两件事——
//   1. 遮挡：把镜头画面按遮罩抠出人，压在雨的上面（雨在人身后）
//   2. 碰撞：粒子坐标查表 O(1)，取代头部椭圆，头发、肩膀、举起的手都算数
//
// 代价是每次推理约 30 ms（Pixel 6 官方数据），所以：跑在 Worker 里、按档位降到 10–15 Hz、
// 低档机不开（退回椭圆）。这是这道题「系统 ROI」的取舍现场。

import { coverMap, screenToVideoX, screenToVideoY, type CoverMap } from './view'

const LOCAL_WASM_BASE = '/wasm'
const CDN_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const LOCAL_MODEL = '/models/selfie_segmenter.tflite'
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'

// 送进模型的帧尺寸。模型内部是 256×256，送 640×480 只是多付一次缩放和四倍的遮罩传输。
const SEND_W = 256
const SEND_H = 192

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' })
    // Vite dev server 对不存在的路径会回 index.html（SPA 兜底），HEAD 也是 200——
    // 必须再看 content-type，否则会把一页 HTML 当模型喂给 MediaPipe（"not a valid Flatbuffer"）
    return r.ok && !(r.headers.get('content-type') || '').includes('text/html')
  } catch {
    return false
  }
}

export interface PersonCollider {
  isPerson(sx: number, sy: number): boolean
  /** 外法线写进 out[0], out[1]（屏幕坐标，已归一化）。零分配。 */
  normal(sx: number, sy: number, out: Float32Array): void
}

export class PersonMask implements PersonCollider {
  private worker: Worker | null = null
  private clone: HTMLVideoElement
  private maskCanvas: HTMLCanvasElement
  private maskCtx: CanvasRenderingContext2D
  private maskImg: ImageData | null = null

  data: Uint8Array | null = null
  mw = 0
  mh = 0
  /**
   * 遮罩里「人」是哪个值。selfie_segmenter 的 categoryMask 实测是 0 = 人、1 = 背景，
   * 和直觉相反，而且不同模型变体不一样。不猜：每帧看画面上沿和左右两边（几乎必然是背景）
   * 哪个值占多数，那个就是背景，另一个就是人。
   */
  private personVal = 1
  ready = false
  delegate: 'GPU' | 'CPU' | '-' = '-'
  lastMs = 0
  lastError = ''
  private busy = false
  private failed = false

  private vw = 640
  private vh = 480
  private w = 1
  private map: CoverMap = { scale: 1, offX: 0, offY: 0 }

  constructor(clone: HTMLVideoElement) {
    this.clone = clone
    this.maskCanvas = document.createElement('canvas')
    this.maskCtx = this.maskCanvas.getContext('2d') as CanvasRenderingContext2D
  }

  get active(): boolean {
    return this.data !== null
  }

  async init(): Promise<void> {
    if (this.worker || this.failed) return
    const wasmBase = (await exists(`${LOCAL_WASM_BASE}/vision_wasm_internal.js`)) ? LOCAL_WASM_BASE : CDN_WASM_BASE
    const modelUrl = (await exists(LOCAL_MODEL)) ? LOCAL_MODEL : CDN_MODEL
    const worker = new Worker(new URL('./segment.worker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    worker.onmessage = (e) => this.onMessage(e.data)
    worker.onerror = (e) => {
      this.lastError = `worker: ${e.message}`.slice(0, 120)
      this.failed = true
      this.stop()
    }
    worker.postMessage({ type: 'init', wasmBase: new URL(wasmBase, location.href).href, modelUrl })
  }

  private onMessage(m: { type: string; [k: string]: unknown }): void {
    if (m.type === 'ready') {
      this.ready = true
      this.delegate = m.delegate as 'GPU' | 'CPU'
    } else if (m.type === 'mask') {
      this.busy = false
      this.data = m.data as Uint8Array
      this.mw = m.w as number
      this.mh = m.h as number
      this.lastMs = m.ms as number
      this.detectPolarity()
      this.updateCssMask()
    } else if (m.type === 'skip') {
      this.busy = false
    } else if (m.type === 'error') {
      // 推理层出错就整个关掉，退回椭圆——绝不让 demo 因为加分项白屏
      this.lastError = String(m.message).slice(0, 120)
      this.failed = true
      this.stop()
    }
  }

  setView(vw: number, vh: number, w: number, h: number): void {
    if (vw > 0 && vh > 0) {
      this.vw = vw
      this.vh = vh
    }
    this.w = w
    coverMap(this.vw, this.vh, w, h, this.map)
    this.applyMaskGeometry()
  }

  /** 每隔几帧调一次；上一帧还没回来就跳过，绝不排队。 */
  request(video: HTMLVideoElement, ts: number): void {
    if (!this.ready || this.busy || !this.worker || video.readyState < 2) return
    this.busy = true
    createImageBitmap(video, { resizeWidth: SEND_W, resizeHeight: SEND_H, resizeQuality: 'low' })
      .then((bmp) => this.worker?.postMessage({ type: 'seg', bmp, ts }, [bmp]))
      .catch(() => {
        this.busy = false
      })
  }

  private detectPolarity(): void {
    const d = this.data as Uint8Array
    const { mw, mh } = this
    let n = 0
    let nonzero = 0
    for (let x = 0; x < mw; x += 2) {
      n++
      if (d[x] > 0) nonzero++
    }
    for (let y = 0; y < mh; y += 2) {
      n += 2
      if (d[y * mw] > 0) nonzero++
      if (d[y * mw + mw - 1] > 0) nonzero++
    }
    // 边缘大多数是非零 → 非零是背景 → 人是 0
    this.personVal = nonzero * 2 > n ? 0 : 1
  }

  private isPersonVal(v: number): boolean {
    return this.personVal === 0 ? v === 0 : v > 0
  }

  // ---------- 遮挡：CSS mask-image ----------
  // 把遮罩画成一张小 PNG 交给 CSS，合成交给浏览器的合成器，
  // 比每帧在 Canvas 2D 里画两次全屏视频便宜得多。

  private updateCssMask(): void {
    const { data, mw, mh } = this
    if (!data) return
    if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh) {
      this.maskCanvas.width = mw
      this.maskCanvas.height = mh
      this.maskImg = this.maskCtx.createImageData(mw, mh)
    }
    const img = this.maskImg as ImageData
    const px = img.data
    for (let i = 0, n = mw * mh; i < n; i++) {
      px[i * 4 + 3] = this.isPersonVal(data[i]) ? 255 : 0
    }
    this.maskCtx.putImageData(img, 0, 0)
    const url = `url(${this.maskCanvas.toDataURL('image/png')})`
    const s = this.clone.style
    s.maskImage = url
    s.webkitMaskImage = url
    this.applyMaskGeometry()
    this.clone.hidden = false
  }

  /** mask 要和 object-fit: cover 裁出来的画面严格对齐：同样的缩放、同样的偏移。 */
  private applyMaskGeometry(): void {
    const m = this.map
    const s = this.clone.style
    const size = `${this.vw * m.scale}px ${this.vh * m.scale}px`
    const pos = `${m.offX}px ${m.offY}px`
    s.maskSize = size
    s.webkitMaskSize = size
    s.maskPosition = pos
    s.webkitMaskPosition = pos
    s.maskRepeat = 'no-repeat'
    s.webkitMaskRepeat = 'no-repeat'
  }

  // ---------- 碰撞：查表 ----------

  isPerson(sx: number, sy: number): boolean {
    const d = this.data
    if (!d) return false
    const vx = screenToVideoX(sx, this.map, this.w)
    const vy = screenToVideoY(sy, this.map)
    if (vx < 0 || vy < 0 || vx >= this.vw || vy >= this.vh) return false
    const mx = ((vx * this.mw) / this.vw) | 0
    const my = ((vy * this.mh) / this.vh) | 0
    return this.isPersonVal(d[my * this.mw + mx])
  }

  private at(mx: number, my: number): number {
    if (mx < 0 || my < 0 || mx >= this.mw || my >= this.mh) return 0
    return this.isPersonVal((this.data as Uint8Array)[my * this.mw + mx]) ? 1 : 0
  }

  normal(sx: number, sy: number, out: Float32Array): void {
    const vx = screenToVideoX(sx, this.map, this.w)
    const vy = screenToVideoY(sy, this.map)
    const mx = ((vx * this.mw) / this.vw) | 0
    const my = ((vy * this.mh) / this.vh) | 0
    // 梯度指向人的内部；外法线取反。屏幕 x 是镜像的，所以 x 分量再翻一次。
    const gx = this.at(mx + 2, my) - this.at(mx - 2, my)
    const gy = this.at(mx, my + 2) - this.at(mx, my - 2)
    let nx = gx
    let ny = -gy
    const l = Math.hypot(nx, ny)
    if (l < 1e-6) {
      out[0] = 0
      out[1] = -1
      return
    }
    out[0] = nx / l
    out[1] = ny / l
  }

  stop(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = false
    this.busy = false
    this.data = null
    this.clone.hidden = true
    this.clone.style.maskImage = ''
    this.clone.style.webkitMaskImage = ''
  }
}
