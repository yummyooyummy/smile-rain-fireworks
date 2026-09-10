// 装配与主循环。
//
// 单一 requestAnimationFrame 循环，一帧内的顺序固定：
//   降频检测 → 采样信号 → 状态机 → 发射器 → 物理与碰撞 → 绘制 → HUD → 档位采样
// 检测每 3 帧跑一次（≈20 Hz），碰撞和渲染每帧跑——降频的是检测，不是碰撞，
// 否则粒子会先穿进头里再被弹出来。

import { startCamera, stopCamera, CameraError_ } from './camera'
import {
  DEFAULT_CONFIG,
  readConfigOverride,
  readFlags,
  TIERS,
  type EffectConfig,
  type Tier,
} from './config'
import { copy } from './copy'
import { FaceTracker } from './face'
import { Hud } from './hud'
import { Effects } from './particles'
import { PersonMask } from './segment'
import { ExpressionState } from './state'

const DETECT_EVERY = 3
const MAX_DPR = 2

const video = document.getElementById('cam') as HTMLVideoElement
const canvas = document.getElementById('fx') as HTMLCanvasElement
const rainCanvas = document.getElementById('rain') as HTMLCanvasElement
const camFront = document.getElementById('camFront') as HTMLVideoElement
const hudRoot = document.getElementById('hud') as HTMLElement

const flags = readFlags()
// 同步用默认值起步（避免 top-level await），effect.json 异步到达后再覆盖
let cfg: EffectConfig = { ...DEFAULT_CONFIG, ...readConfigOverride() }
if (flags.debug) cfg.showDebug = true

fetch('effect.json', { cache: 'no-cache' })
  .then((r) => (r.ok ? r.json() : null))
  .then((json) => {
    if (!json) return
    applyConfig({ ...DEFAULT_CONFIG, ...json, ...readConfigOverride(), ...(flags.debug ? { showDebug: true } : {}) })
  })
  .catch(() => {
    /* 用默认值，绝不因为配置文件让 demo 白屏 */
  })

function applyConfig(next: EffectConfig): void {
  cfg = next
  effects.setConfig(cfg)
  state.setConfig(cfg)
  applySegTier()
}

let tier: Tier = flags.tier ? TIERS[flags.tier] : TIERS.mid
const effects = new Effects(canvas, cfg, tier)
const state = new ExpressionState(cfg)
const face = new FaceTracker()
// 人像分割：遮挡（雨在人身后）+ 像素级碰撞。只在中/高档开，低档退回头部椭圆。
const person = new PersonMask(camFront)
let segEvery = 6
let segOn = false

let stream: MediaStream | null = null
let cameraOn = false
let running = false
let frame = 0
let last = 0
let w = 0
let h = 0

// 引导：三步走完就不再出现
let guideDone = false
let guideDoneAt = 0

const hud = new Hud(hudRoot, {
  onStart: () => void connect(true),
  onFallback: () => {
    hud.hideStart()
    enterManualMode()
  },
  onReconnect: () => void connect(!inScene),
  onExit: () => exitToStart(),
  onManualTap: () => state.forceRain(3),
  onManualHold: () => state.forceBurst(),
  onGear: (advanced) => window.dispatchEvent(new CustomEvent('open-drawer', { detail: { advanced } })),
  onResume: () => resumeFromIdle(),
})

// 抽屉里的「重看新手引导」
window.addEventListener('replay-guide', () => {
  state.resetGuide()
  guideDone = false
  guideDoneAt = 0
})

// 供抽屉读写配置的最小接口，避免 Cursor 改动引擎内部
Object.assign(window, {
  __fx: {
    getConfig: () => cfg,
    setConfig: (next: EffectConfig) => applyConfig(next),
    getTier: () => effects.currentTier.name,
    person, // 调试用：可以从控制台喂一张假遮罩验证碰撞与遮挡链路
  },
})

resize()
window.addEventListener('resize', resize)
window.addEventListener('orientationchange', () => setTimeout(resize, 250))

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    running = false
  } else if (!running && !idlePaused && inScene) {
    face.resetClock()
    last = 0
    startLoop()
  }
})

// 键盘快捷键：D 随时开关调试面板（不用手动改 URL），1/2 手动触发
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return
  const k = e.key.toLowerCase()
  if (k === 'd') applyConfig({ ...cfg, showDebug: !cfg.showDebug })
  if (k === '1') state.forceRain(3)
  if (k === '2') state.forceBurst()
})

// 调试用的虚拟头：没有摄像头时，按住/移动指针即可当成一颗头，
// 用来验证碰撞与分裂效果（Cursor 调试碰撞时也用这个，不必对着镜头）。
const testHead = { cx: 0, cy: 0, rx: 95, ry: 125, rot: 0 }
let testHeadOn = false
window.addEventListener('pointermove', (e) => {
  if (cameraOn || !cfg.showDebug) return
  testHead.cx = e.clientX
  testHead.cy = e.clientY
  testHeadOn = true
})

function resize(): void {
  w = window.innerWidth
  h = window.innerHeight
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
  effects.resize(w, h, dpr)
  person.setView(video.videoWidth, video.videoHeight, w, h)
}

/** 分割按档位开关：high 每 4 帧（≈15 Hz），mid 每 6 帧（≈10 Hz），low 关。 */
function applySegTier(): void {
  const want = cameraOn && flags.seg && cfg.personSeg && tier.name !== 'low'
  segEvery = tier.name === 'high' ? 4 : 6
  if (want && !segOn) {
    segOn = true
    effects.setRainLayer(rainCanvas)
    void person.init()
  } else if (!want && segOn) {
    segOn = false
    person.stop()
    effects.setRainLayer(null)
  }
}

/**
 * 授权 → 模型 → 开跑。这条链路上每一步都可能失败，所以它必须能被重复调用：
 * 用户在错误页点「重试」、在手动模式横幅点「重新连接摄像头」，走的都是这里，
 * 而不是 location.reload()——刷新会把 4MB 模型重新下一遍。
 */
let connecting = false
/** 是否已进入主画面（退出后为 false）。决定重连时的反馈落在开始页还是横幅上。 */
let inScene = false

async function connect(fromStart: boolean): Promise<void> {
  if (connecting) return
  connecting = true
  if (fromStart) hud.setStartState({ kind: 'camera' })
  else hud.setReconnecting(true)

  try {
    stream = await startCamera(video)
    cameraOn = true
    camFront.srcObject = stream
    void camFront.play().catch(() => {})
    person.setView(video.videoWidth, video.videoHeight, w, h)
  } catch (e) {
    const kind =
      e instanceof CameraError_
        ? e.kind === 'denied'
          ? 'denied'
          : e.kind === 'timeout'
            ? 'timeout'
            : 'unsupported'
        : 'unsupported'
    fail(fromStart, kind)
    return
  }

  // 模型只初始化一次：重连时往往已在内存里
  if (!face.ready) {
    try {
      if (fromStart) hud.setStartState({ kind: 'model' })
      await face.init((loaded, total) => {
        if (!fromStart) return
        hud.setStartState({ kind: 'model', pct: total > 0 ? Math.round((loaded / total) * 100) : undefined })
      })
    } catch {
      stopCamera(stream)
      stream = null
      cameraOn = false
      fail(fromStart, 'modelFail')
      return
    }
  }

  if (fromStart) hud.setStartState({ kind: 'warmup' })
  idlePaused = false
  noFaceMs = 0
  hud.showPaused(false)
  face.resetClock()
  connecting = false
  inScene = true
  hud.hideStart()
  hud.showControls({ camera: true, clean: flags.clean })
  applySegTier()
  startLoop()
}

/** 失败不跳页：开始页按钮自己变成「摄像头未开启，直接开始」；主画面里则横幅按钮复位。 */
function fail(fromStart: boolean, reason: 'denied' | 'unsupported' | 'timeout' | 'modelFail'): void {
  connecting = false
  if (fromStart) hud.setStartState({ kind: 'failed', reason })
  else hud.setReconnecting(false)
}

/** 退出：停摄像头、清粒子、回开始页。已授权过的话下次点开始不会再弹权限。 */
function exitToStart(): void {
  running = false
  idlePaused = false
  stopCamera(stream)
  stream = null
  video.srcObject = null
  camFront.srcObject = null
  cameraOn = false
  applySegTier()
  inScene = false
  effects.clear()
  effects.setRainRate(0)
  state.reset()
  guideDone = false
  guideDoneAt = 0
  hud.showStart()
}

/**
 * 长时间没人 → 停掉 rAF。手机上把页面开着不管，摄像头 + 每帧检测 + 粒子会一直烧电。
 * 只在有摄像头时启用——手动模式下「没有脸」是常态。
 */
const IDLE_PAUSE_MS = 60_000
const NO_FACE_HINT_MS = 3_000
let noFaceMs = 0
let idlePaused = false

function pauseFromIdle(): void {
  idlePaused = true
  running = false
  noFaceMs = 0
  hud.showPaused(true)
}

function resumeFromIdle(): void {
  if (!idlePaused) return
  idlePaused = false
  noFaceMs = 0
  hud.showPaused(false)
  face.resetClock()
  last = 0
  startLoop()
}

/** 没有摄像头也必须能玩。但要让用户知道自己在手动模式，并给一条回去的路。 */
function enterManualMode(): void {
  cameraOn = false
  inScene = true
  idlePaused = false
  noFaceMs = 0
  hud.showPaused(false)
  hud.showControls({ camera: false, clean: flags.clean })
  startLoop()
}

function startLoop(): void {
  if (running) return
  running = true
  requestAnimationFrame(loop)
}

// ---------- 档位自适应 ----------
let emaFrame = 16
let warmup = 0
let warmedUp = false
let downTimer = 0
let upTimer = 0

function sampleTier(frameMs: number, dt: number): void {
  // 首次检测要编译 GPU shader，单帧能卡 300–800 ms；这种一次性尖峰不代表设备性能，
  // 进了 EMA 会把一台 4 ms/帧 的电脑判成 low 档（真实发生过）。尖峰不计入。
  if (frameMs > 80) return
  emaFrame += (frameMs - emaFrame) * 0.05
  if (flags.tier) return // 钉住档位时不自适应

  if (!warmedUp) {
    warmup += dt
    if (warmup >= 2) {
      warmedUp = true
      setTier(emaFrame < 14 ? TIERS.high : emaFrame < 22 ? TIERS.mid : TIERS.low)
    }
    return
  }

  downTimer = emaFrame > 25 ? downTimer + dt : 0
  upTimer = emaFrame < 14 ? upTimer + dt : 0

  if (downTimer >= 3) {
    downTimer = 0
    if (tier.name === 'high') setTier(TIERS.mid)
    else if (tier.name === 'mid') setTier(TIERS.low)
  } else if (upTimer >= 5) {
    upTimer = 0
    if (tier.name === 'low') setTier(TIERS.mid)
    else if (tier.name === 'mid') setTier(TIERS.high)
  }
}

function setTier(next: Tier): void {
  if (next.name === tier.name) return
  tier = next
  effects.setTier(next)
  applySegTier()
}

// ---------- 主循环 ----------

function loop(now: number): void {
  if (!running) return
  const frameStart = now
  if (!last) last = now
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now
  frame++

  // 1. 降频检测（表情每 3 帧；人像分割每 4–6 帧，且在 Worker 里，不会卡这条线程）
  if (cameraOn && face.ready && frame % DETECT_EVERY === 0) {
    face.detect(video, w, h)
  }
  if (segOn && frame % segEvery === 0) person.request(video, now)

  // 2. 信号采样（含 EMA 平滑与头部插值）
  const sig = face.sample(dt)

  // 3. 状态机
  state.update(sig, dt)

  // 4. 发射：烟花从画面底部升空，到高处再炸开，粒子受重力落到人身上
  if (state.burstPending) {
    state.burstPending = false
    effects.launch(state.burstPower, state.burstScale, cameraOn ? sig.head : testHeadOn && cfg.showDebug ? testHead : null)
  }
  effects.setRainRate(state.rainRate)

  // 5. 物理 + 碰撞（每帧）
  const head = cameraOn ? sig.head : testHeadOn && cfg.showDebug ? testHead : null
  const usePerson = segOn && person.active
  effects.update(dt, head, usePerson ? person : null)

  // 6. 绘制（人像模式下头部脉冲那圈椭圆没有意义，不画）
  effects.draw(usePerson ? null : head)
  if (cfg.showDebug || cfg.showCollider) {
    if (usePerson) person.drawDebug(effects.ctx2d, w)
    else if (head) effects.drawDebugHead(head)
  }

  // 7. HUD
  if (cameraOn) noFaceMs = sig.faceOk ? 0 : noFaceMs + dt * 1000
  updateHud(sig, now)

  // 7.5 空闲暂停
  if (cameraOn && noFaceMs >= IDLE_PAUSE_MS) {
    pauseFromIdle()
    return
  }

  // 8. 档位
  sampleTier(performance.now() - frameStart, dt)

  requestAnimationFrame(loop)
}

function updateHud(sig: ReturnType<FaceTracker['sample']>, now: number): void {
  if (effects.stats.collisions > 0) state.reachedCollision = true

  // 引导三步 → 走完只留两根进度条（各自独立，互不清零）
  const sp = state.smileProgress
  const lp = state.laughProgress
  if (!cfg.showGuide || flags.clean || !cameraOn) {
    hud.setGuide(null, 0, 0)
  } else if (guideDone) {
    hud.setGuide('', sp, lp)
  } else if (!state.reachedSmile) {
    hud.setGuide(copy.guide.step1, sp, lp)
  } else if (!state.reachedLaugh) {
    hud.setGuide(copy.guide.step2, sp, lp)
  } else if (!state.reachedCollision) {
    hud.setGuide(copy.guide.step3, sp, lp)
  } else {
    if (!guideDoneAt) guideDoneAt = now
    hud.setGuide(copy.guide.done, sp, lp)
    if (now - guideDoneAt > 2000) guideDone = true
  }

  // 状态提示
  if (!cameraOn) hud.setStatus(null)
  else if (!sig.faceOk) hud.setStatus(noFaceMs >= NO_FACE_HINT_MS ? copy.status.noFace : null)
  else if (sig.lowConfidence) hud.setStatus(copy.status.lowLight)
  else hud.setStatus(null)

  // 调试面板
  if (cfg.showDebug) {
    const s = effects.stats
    hud.setDebug(
      [
        `mode      ${state.mode}`,
        `smile     ${sig.smile.toFixed(3)}   jawOpen ${sig.jawOpen.toFixed(3)}`,
        `rainRate  ${state.rainRate.toFixed(2)}   bars ${state.smileProgress.toFixed(2)}/${state.laughProgress.toFixed(2)}`,
        `fps       ${(1000 / emaFrame).toFixed(0)}   frame ${emaFrame.toFixed(1)}ms`,
        `detect    ${face.lastDetectMs.toFixed(1)}ms (${face.delegate}, 每 ${DETECT_EVERY} 帧)`,
        `assets    ${face.assetSource}   headRot ${face.headRotDeg.toFixed(1)}°`,
        `person    ${segOn ? (person.active ? `on ${person.lastMs.toFixed(0)}ms (${person.delegate}, 每 ${segEvery} 帧) ${person.mw}x${person.mh}` : person.ready ? 'ready' : person.lastError ? `fail ${person.lastError}` : 'loading') : person.lastError ? `fail ${person.lastError}` : 'off'}`,
        `tier      ${tier.name}   rain ${s.rainAlive}   spark ${s.sparkAlive}   rocket ${s.rocketAlive}`,
        `collide   ${s.collisions}/frame`,
      ].join('\n'),
    )
  } else {
    hud.setDebug(null)
  }
}

window.addEventListener('pagehide', () => stopCamera(stream))
