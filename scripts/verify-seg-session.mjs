// 分割会话隔离 + 人脸检测调度契约。
// 无摄像头、不启动 Worker。真机显示仍须人工看。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const segmentSrc = readFileSync(join(root, 'src/segment.ts'), 'utf8')
const workerSrc = readFileSync(join(root, 'src/segment.worker.ts'), 'utf8')
const mainSrc = readFileSync(join(root, 'src/main.ts'), 'utf8')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(
  /const gen = this\.gen\n    const worker = this\.worker\n    this\.busy = true\n    this\.inflightGen = gen\n    createImageBitmap/.test(segmentSrc),
  'request() 必须在 createImageBitmap 之前捕获 gen 并记下 inflightGen',
)
assert(segmentSrc.includes('worker.postMessage({ type: \'seg\', bmp, ts, gen }, [bmp])'), '成功路径必须 transfer 位图')
assert(
  /try \{\s*worker\.postMessage[\s\S]*?bmp\.close\(\)/.test(segmentSrc),
  'postMessage 抛错时必须尝试 close 仍由主线程持有的位图',
)
assert(
  /this\.releaseInflight\(m\.gen as number\)\n      if \(m\.gen !== this\.gen \|\| this\.paused\) return/.test(segmentSrc),
  '过期 mask 也必须先释放 inflight/busy，再拒绝应用',
)
assert(/finally \{[\s\S]*res\?\.close\(\)[\s\S]*m\.bmp\.close\(\)/.test(workerSrc), 'Worker segment 必须用 finally 关闭 res 与 bmp')
assert(segmentSrc.includes('this.paused = false'), 'resume 必须解除 paused')
assert(/pause\(\): void \{[\s\S]*this\.hideAndClearMask\(\)/.test(segmentSrc), 'pause 必须清理显示层')
assert(/stop\(\): void \{[\s\S]*this\.hideAndClearMask\(\)/.test(segmentSrc), 'stop 必须清理显示层')
assert(/seq !== this\.maskSeq/.test(segmentSrc), 'Image 解码必须校验同会话序号')
assert(!segmentSrc.includes('this.busy = false\n    this.data = null\n    this.lastMaskAt = 0\n    this.hz = 0\n    this.clone.hidden = true'), 'pause 不得为了恢复而提前清 busy')
assert(/const DETECT_INTERVAL_MS = 50/.test(mainSrc), '人脸检测必须按墙钟 50ms 限频')
assert(/vt !== lastVideoTime/.test(mainSrc), '同一视频帧不得重复检测')
assert(!/frame % DETECT_EVERY/.test(mainSrc), '人脸检测不得再按 rAF 帧计数')

function makeSession() {
  return {
    gen: 0,
    paused: false,
    busy: false,
    inflightGen: -1,
    maskSeq: 0,
    worker: null,
    data: null,
    hidden: true,
    mask: '',
    applied: 0,
    bmpClosed: 0,
    sent: 0,
    overlayShown: 0,
    queued: 0,
  }
}

function resume(s) {
  s.paused = false
  if (!s.worker) s.worker = { id: s.gen }
}

function pause(s) {
  s.gen++
  s.maskSeq++
  s.paused = true
  s.data = null
  s.hidden = true
  s.mask = ''
}

function stop(s) {
  s.gen++
  s.maskSeq++
  s.paused = true
  s.busy = false
  s.inflightGen = -1
  s.worker = null
  s.data = null
  s.hidden = true
  s.mask = ''
}

function request(s) {
  if (s.busy || !s.worker || s.paused) return null
  const gen = s.gen
  const worker = s.worker
  s.busy = true
  s.inflightGen = gen
  return { gen, worker }
}

function bitmapDone(s, job, postMessageThrows = false) {
  if (job.gen !== s.gen || s.paused || s.worker !== job.worker) {
    s.bmpClosed++
    if (s.inflightGen === job.gen) {
      s.inflightGen = -1
      s.busy = false
    }
    return 'closed'
  }
  if (postMessageThrows) {
    s.bmpClosed++
    if (s.inflightGen === job.gen) {
      s.inflightGen = -1
      s.busy = false
    }
    return 'send-fail'
  }
  s.sent++
  s.queued++
  return 'sent'
}

function releaseInflight(s, msgGen) {
  if (s.inflightGen !== msgGen) return
  s.inflightGen = -1
  s.busy = false
}

function onMask(s, msgGen) {
  s.queued = Math.max(0, s.queued - 1)
  releaseInflight(s, msgGen)
  if (msgGen !== s.gen || s.paused) return 'drop'
  s.data = 'mask'
  return 'apply'
}

function onSkip(s, msgGen) {
  s.queued = Math.max(0, s.queued - 1)
  releaseInflight(s, msgGen)
  return s.inflightGen === -1 ? 'busy-clear' : 'ignored-busy'
}

function decodeDone(s, capturedGen, seq) {
  if (capturedGen !== s.gen || s.paused || seq !== s.maskSeq) return 'drop'
  s.mask = 'url'
  s.hidden = false
  s.overlayShown++
  return 'show'
}

function beginDecode(s) {
  return { gen: s.gen, seq: ++s.maskSeq }
}

function shouldDetect(now, lastDetectAt, intervalMs, videoTime, lastVideoTime) {
  return now - lastDetectAt >= intervalMs && videoTime !== lastVideoTime
}

let fail = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}: ${e.message}`)
  }
}

check('异步输入创建期间关闭：位图 close 且不发送', () => {
  const s = makeSession()
  resume(s)
  const job = request(s)
  stop(s)
  assert(bitmapDone(s, job) === 'closed', '应 close 未发送位图')
  assert(s.sent === 0, '不得 postMessage')
  assert(s.bmpClosed === 1, '应释放位图')
  assert(s.hidden && s.mask === '' && s.data === null, '应立即藏层并清遮罩')
})

check('postMessage 抛错：关闭仍由主线程持有的位图，且释放 busy', () => {
  const s = makeSession()
  resume(s)
  const job = request(s)
  assert(bitmapDone(s, job, true) === 'send-fail')
  assert(s.sent === 0)
  assert(s.bmpClosed === 1)
  assert(s.busy === false)
})

check('Worker 推理期间关闭：过期 mask 不得应用；stop 因 terminate 才清 busy', () => {
  const s = makeSession()
  resume(s)
  const job = request(s)
  assert(bitmapDone(s, job) === 'sent')
  stop(s)
  assert(onMask(s, job.gen) === 'drop', '过期 mask 应丢弃')
  assert(s.data === null, '不得写入 data')
  assert(s.busy === false, 'stop 已清 busy')
  const dec = { gen: job.gen, seq: 1 }
  assert(decodeDone(s, dec.gen, dec.seq) === 'drop', '过期 Image 解码不得显层')
  assert(s.hidden && s.overlayShown === 0 && s.mask === '')
})

check('开→关→开：旧结果不得覆盖新会话，也不得解除新 busy', () => {
  const s = makeSession()
  resume(s)
  const old = request(s)
  assert(bitmapDone(s, old) === 'sent')
  stop(s)
  resume(s)
  const neu = request(s)
  assert(neu.gen !== old.gen, '新请求必须带着新代数')
  assert(s.busy === true, '新请求应占用 busy')
  assert(onMask(s, old.gen) === 'drop', '旧 mask 不得应用')
  assert(s.busy === true, '旧 skip/mask 不得清新 busy')
  assert(s.data === null)
  assert(onMask(s, neu.gen) === 'apply', '新会话自己的结果应能应用')
  assert(s.busy === false)
  assert(s.data === 'mask')
})

check('已暂停时关闭，以及重复关闭；pause/stop 都清显示层', () => {
  const s = makeSession()
  resume(s)
  s.mask = 'stale'
  s.hidden = false
  s.data = 'mask'
  pause(s)
  assert(s.hidden && s.mask === '', 'pause 应藏层并清 CSS 遮罩')
  stop(s)
  assert(s.mask === '' && s.hidden && s.data === null)
  const genAfterFirst = s.gen
  stop(s)
  assert(s.gen === genAfterFirst + 1, 'stop 可重复')
  assert(request(s) === null, 'stop 之后未 resume 不得再送帧')
})

check('resume 解除 paused；pause 不清 busy，避免 Worker 积压', () => {
  const s = makeSession()
  resume(s)
  const a = request(s)
  assert(bitmapDone(s, a) === 'sent')
  pause(s)
  assert(s.paused === true && s.busy === true, 'pause 应保持 busy')
  resume(s)
  assert(s.paused === false, 'resume 必须解除 paused')
  assert(request(s) === null, '在飞任务未回来前不得再送')
  assert(s.queued === 1, '队列不得增长')
  assert(onMask(s, a.gen) === 'drop')
  assert(s.busy === false)
  const b = request(s)
  assert(b !== null, '旧结果释放 busy 后才允许新请求')
  assert(bitmapDone(s, b) === 'sent')
  assert(s.queued === 1)
})

check('同会话旧 Image 解码不得覆盖新遮罩', () => {
  const s = makeSession()
  resume(s)
  const first = beginDecode(s)
  const second = beginDecode(s)
  assert(decodeDone(s, first.gen, first.seq) === 'drop')
  assert(s.overlayShown === 0)
  assert(decodeDone(s, second.gen, second.seq) === 'show')
  assert(s.overlayShown === 1)
})

check('人脸检测：50ms 限频且同一 currentTime 不重复', () => {
  const interval = 50
  assert(shouldDetect(50, 0, interval, 0.1, -1) === true, '间隔到且新帧应检测')
  assert(shouldDetect(40, 0, interval, 0.2, -1) === false, '间隔未到不得检测')
  assert(shouldDetect(80, 0, interval, 0.3, 0.3) === false, '同一视频帧不得再跑')
  assert(shouldDetect(80, 0, interval, 0.4, 0.3) === true, '新视频帧且间隔到应检测')
  let lastAt = 0
  let lastVt = -1
  let n = 0
  for (let now = 0; now <= 200; now += 8) {
    const vt = Math.floor(now / 33) * 0.033
    if (shouldDetect(now, lastAt, interval, vt, lastVt)) {
      lastAt = now
      lastVt = vt
      n++
    }
  }
  assert(n <= 5, `200ms 内按 8ms rAF 不得检出 ${n} 次（应约 20Hz）`)
  assert(n >= 3, `200ms 内至少应有几次检测，实际 ${n}`)
})

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
if (fail) process.exit(1)
