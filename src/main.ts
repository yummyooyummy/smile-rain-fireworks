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
import { ExpressionState } from './state'

const DETECT_EVERY = 3
const MAX_DPR = 2

const video = document.getElementById('cam') as HTMLVideoElement
const canvas = document.getElementById('fx') as HTMLCanvasElement
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
}

let tier: Tier = TIERS.mid
const effects = new Effects(canvas, cfg, tier)
const state = new ExpressionState(cfg)
const face = new FaceTracker()

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
  onStart: () => void boot(),
  onManualTap: () => state.forceRain(3),
  onManualHold: () => {
    state.forceBurst()
  },
  onGearClick: () => {
    // 高级模式抽屉由 Cursor 实现，见 TODO-for-cursor.md
    window.dispatchEvent(new CustomEvent('open-drawer'))
  },
  onFallback: () => {
    cameraOn = false
    hud.showControls({ gear: !flags.clean })
    startLoop()
  },
})

// 供抽屉读写配置的最小接口，避免 Cursor 改动引擎内部
Object.assign(window, {
  __fx: {
    getConfig: () => cfg,
    setConfig: (next: EffectConfig) => applyConfig(next),
    getTier: () => effects.currentTier.name,
  },
})

resize()
window.addEventListener('resize', resize)
window.addEventListener('orientationchange', () => setTimeout(resize, 250))

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    running = false
  } else if (!running) {
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
}

async function boot(): Promise<void> {
  hud.setLoading(true)
  try {
    stream = await startCamera(video)
    cameraOn = true
  } catch (e) {
    hud.setLoading(false)
    hud.hideStart()
    hud.showError(e instanceof CameraError_ && e.kind === 'denied' ? 'denied' : 'unsupported')
    return
  }

  try {
    await face.init()
  } catch {
    hud.setLoading(false)
    hud.hideStart()
    hud.showError('modelFail')
    return
  }

  hud.setLoading(false)
  hud.hideStart()
  hud.showControls({ gear: !flags.clean })
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
  emaFrame += (frameMs - emaFrame) * 0.05

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
  } else if (upTimer >= 10) {
    upTimer = 0
    if (tier.name === 'low') setTier(TIERS.mid)
    else if (tier.name === 'mid') setTier(TIERS.high)
  }
}

function setTier(next: Tier): void {
  if (next.name === tier.name) return
  tier = next
  effects.setTier(next)
}

// ---------- 主循环 ----------

function loop(now: number): void {
  if (!running) return
  const frameStart = now
  if (!last) last = now
  const dt = Math.min((now - last) / 1000, 0.05)
  last = now
  frame++

  // 1. 降频检测
  if (cameraOn && face.ready && frame % DETECT_EVERY === 0) {
    face.detect(video, w, h)
  }

  // 2. 信号采样（含 EMA 平滑与头部插值）
  const sig = face.sample(dt)

  // 3. 状态机
  state.update(sig, dt)

  // 4. 发射：烟花从画面底部升空，到高处再炸开，粒子受重力落到人身上
  if (state.burstPending) {
    state.burstPending = false
    effects.launch(state.burstPower, state.burstScale)
  }
  effects.setRainRate(state.rainRate)

  // 5. 物理 + 碰撞（每帧）
  const head = cameraOn ? sig.head : testHeadOn && cfg.showDebug ? testHead : null
  effects.update(dt, head)

  // 6. 绘制
  effects.draw(head)
  if (cfg.showDebug && head) effects.drawDebugHead(head)

  // 7. HUD
  updateHud(sig, now)

  // 8. 档位
  sampleTier(performance.now() - frameStart, dt)

  requestAnimationFrame(loop)
}

function updateHud(sig: ReturnType<FaceTracker['sample']>, now: number): void {
  if (effects.stats.collisions > 0) state.reachedCollision = true

  // 引导三步 → 走完只留进度条
  // 进度条是「我离触发还差多少」的常驻反馈，不能跟着提示文字一起消失，
  // 否则第二次开始用户就再也不知道自己笑得够不够。
  if (!cfg.showGuide || flags.clean || !cameraOn) {
    hud.setGuide(null, 0, 'none')
  } else if (guideDone) {
    hud.setGuide('', state.guideProgress, state.guidePhase)
  } else if (!state.reachedSmile) {
    hud.setGuide(copy.guide.step1, state.guideProgress, 'smile')
  } else if (!state.reachedLaugh) {
    hud.setGuide(copy.guide.step2, state.guideProgress, 'laugh')
  } else if (!state.reachedCollision) {
    hud.setGuide(copy.guide.step3, state.guideProgress, state.guidePhase)
  } else {
    if (!guideDoneAt) guideDoneAt = now
    hud.setGuide(copy.guide.done, state.guideProgress, state.guidePhase)
    if (now - guideDoneAt > 2000) guideDone = true
  }

  // 状态提示
  if (!cameraOn) hud.setStatus(null)
  else if (!sig.faceOk) hud.setStatus(copy.status.noFace)
  else if (sig.lowConfidence) hud.setStatus(copy.status.lowLight)
  else hud.setStatus(null)

  // 调试面板
  if (cfg.showDebug) {
    const s = effects.stats
    hud.setDebug(
      [
        `mode      ${state.mode}`,
        `smile     ${sig.smile.toFixed(3)}   jawOpen ${sig.jawOpen.toFixed(3)}`,
        `rainRate  ${state.rainRate.toFixed(2)}   guide ${state.guideProgress.toFixed(2)}`,
        `fps       ${(1000 / emaFrame).toFixed(0)}   frame ${emaFrame.toFixed(1)}ms`,
        `detect    ${face.lastDetectMs.toFixed(1)}ms (${face.delegate}, 每 ${DETECT_EVERY} 帧)`,
        `assets    ${face.assetSource}   headRot ${face.headRotDeg.toFixed(1)}°`,
        `tier      ${tier.name}   rain ${s.rainAlive}   spark ${s.sparkAlive}   rocket ${s.rocketAlive}`,
        `collide   ${s.collisions}/frame`,
      ].join('\n'),
    )
  } else {
    hud.setDebug(null)
  }
}

window.addEventListener('pagehide', () => stopCamera(stream))
