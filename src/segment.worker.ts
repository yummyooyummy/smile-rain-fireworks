// 人像分割 Worker。
// segmentForVideo 是同步调用，在 Pixel 6 上约 33 ms——放在主线程每 6 帧就会顿一下，
// 所以整个推理搬进 Worker，主线程只收一张 Uint8 遮罩（可转移，零拷贝）。

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

type InitMsg = { type: 'init'; wasmBase: string; modelUrl: string }
type SegMsg = { type: 'seg'; bmp: ImageBitmap; ts: number }

let seg: ImageSegmenter | null = null

// wasm-feature-detect 的 SIMD 探测字节，和 MediaPipe 内部选 simd / nosimd 的判断一致
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
])

/**
 * MediaPipe 在 Worker 里用 importScripts 加载 wasm 的 JS 胶水；模块 Worker 里 importScripts
 * 会抛 TypeError，它就退回 dynamic import——但胶水文件里 `var ModuleFactory` 是模块作用域的，
 * 挂不到 self 上，于是报「ModuleFactory not set」。这里自己把胶水取回来、在全局作用域执行一次。
 * Vite 只能可靠地打包模块 Worker，所以走这条路而不是改成 classic Worker。
 */
async function preloadGlue(wasmBase: string): Promise<void> {
  const simd = WebAssembly.validate(SIMD_PROBE)
  const url = `${wasmBase}/vision_wasm_${simd ? '' : 'nosimd_'}internal.js`
  const src = await (await fetch(url)).text()
  const factory = new Function(`${src}
;return ModuleFactory;`)()
  ;(self as unknown as { ModuleFactory: unknown }).ModuleFactory = factory
}

async function init(m: InitMsg): Promise<void> {
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: m.modelUrl, delegate },
    runningMode: 'VIDEO' as const,
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  })
  let delegate: 'GPU' | 'CPU' = 'GPU'
  // MediaPipe 每次建图都会把 self.ModuleFactory 用掉，所以每次尝试前都重新挂一次
  try {
    await preloadGlue(m.wasmBase)
    const vision = await FilesetResolver.forVisionTasks(m.wasmBase)
    seg = await ImageSegmenter.createFromOptions(vision, opts('GPU'))
  } catch {
    delegate = 'CPU'
    await preloadGlue(m.wasmBase)
    const vision = await FilesetResolver.forVisionTasks(m.wasmBase)
    seg = await ImageSegmenter.createFromOptions(vision, opts('CPU'))
  }
  self.postMessage({ type: 'ready', delegate })
}

function segment(m: SegMsg): void {
  if (!seg) {
    m.bmp.close()
    self.postMessage({ type: 'skip' })
    return
  }
  const t0 = performance.now()
  const res = seg.segmentForVideo(m.bmp, m.ts)
  const mask = res.categoryMask
  if (!mask) {
    res.close()
    m.bmp.close()
    self.postMessage({ type: 'skip' })
    return
  }
  // getAsUint8Array 返回的是 MediaPipe 内部缓冲的视图，close() 之后就失效，必须拷一份再转移
  const data = mask.getAsUint8Array().slice()
  const w = mask.width
  const h = mask.height
  res.close()
  m.bmp.close()
  const ms = performance.now() - t0
  ;(self as unknown as Worker).postMessage({ type: 'mask', data, w, h, ms }, [data.buffer])
}

self.onmessage = (e: MessageEvent<InitMsg | SegMsg>) => {
  if (e.data.type === 'init') {
    init(e.data).catch((err) => self.postMessage({ type: 'error', message: String(err) }))
  } else if (e.data.type === 'seg') {
    try {
      segment(e.data)
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) })
    }
  }
}
