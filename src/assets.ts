// 运行时资源：优先同源（scripts/prepare-assets.mjs 构建前备好），本地没有再回退 CDN。
// storage.googleapis.com 在国内经常不可达，不能当唯一来源。

export const LOCAL_WASM_BASE = 'wasm'
export const CDN_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'

export const LOCAL_FACE_MODEL = 'models/face_landmarker.task'
export const CDN_FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

export const LOCAL_SEG_MODEL = 'models/selfie_segmenter.tflite'
export const CDN_SEG_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'

export async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' })
    // Vite dev server 对不存在的路径会回 index.html（SPA 兜底），HEAD 也是 200——
    // 必须再看 content-type，否则会把一页 HTML 当模型喂给 MediaPipe（"not a valid Flatbuffer"）
    return r.ok && !(r.headers.get('content-type') || '').includes('text/html')
  } catch {
    return false
  }
}
