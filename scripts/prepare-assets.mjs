// 把 MediaPipe 的 wasm 与模型准备成同源资源。
//
// 为什么必须自托管：Demo 的评审很可能在国内网络下打开。
// storage.googleapis.com 在国内不可达，cdn.jsdelivr.net 也时好时坏——
// 一旦其中之一挂掉，整个 Demo 直接白屏。所以运行时资源全部走自己的域名，
// CDN 只作为「本地资源不存在」时的兜底。
//
// dev 与 build 前自动执行（见 package.json 的 predev / prebuild）。
// 拿不到网络时只警告、不失败：本地照样能开发，运行时会自动回退到 CDN。

import { createWriteStream, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const wasmDest = path.join(root, 'public', 'wasm')
const modelDir = path.join(root, 'public', 'models')
const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    minBytes: 1_000_000,
  },
  {
    file: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
    minBytes: 100_000,
  },
]

// 只拷 SIMD 与 nosimd 两个变体，module 变体本项目用不到（省 12 MB 部署体积）
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]

function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.warn('[assets] 找不到 node_modules 里的 wasm，跳过（运行时会回退 CDN）')
    return
  }
  mkdirSync(wasmDest, { recursive: true })
  let n = 0
  for (const f of WASM_FILES) {
    const from = path.join(wasmSrc, f)
    const to = path.join(wasmDest, f)
    if (!existsSync(from)) continue
    if (existsSync(to) && statSync(to).size === statSync(from).size) continue
    copyFileSync(from, to)
    n++
  }
  console.log(`[assets] wasm 就绪（本次复制 ${n} 个文件）`)
}

async function fetchModel({ file, url, minBytes }) {
  const modelPath = path.join(modelDir, file)
  if (existsSync(modelPath) && statSync(modelPath).size > minBytes) {
    console.log(`[assets] ${file} 已存在，跳过下载`)
    return
  }
  mkdirSync(modelDir, { recursive: true })
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60_000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(modelPath))
    console.log(`[assets] ${file} 已下载 ${(statSync(modelPath).size / 1e6).toFixed(1)} MB`)
  } catch (e) {
    console.warn(
      `[assets] ${file} 下载失败（${e instanceof Error ? e.message : e}）。` +
        `运行时会自动回退到官方 CDN；如果部署环境在国内，请手动把 ${file} 放到 public/models/。`,
    )
  }
}

copyWasm()
for (const m of MODELS) await fetchModel(m)
