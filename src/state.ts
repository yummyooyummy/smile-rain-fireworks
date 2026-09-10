// 表情状态机：三态（Idle / Smiling / Laughing）。
//
// 两条分工，别混：
//   状态机只决定「现在是哪个模式」；
//   效果强度（雨量、烟花粒子数）由连续信号驱动，不由状态驱动。
// 所以浅笑到大笑之间雨量是平滑变化的，而不是几个档位跳变。
//
// 「爆发」不是一个状态，是 Laughing 内部的事件——否则会出现
// 「爆发动画播到一半嘴合上了该去哪」这种没法定义的转移。

import type { EffectConfig } from './config'
import type { Signals } from './face'

export type Mode = 'idle' | 'smiling' | 'laughing'

/** 阈值判定的持续时间。注释里的帧数按 20 Hz 检测频率折算。 */
const HOLD_SMILE_ENTER = 300 // ≈6 检测帧
const HOLD_SMILE_EXIT = 500 // ≈10 检测帧
const HOLD_LAUGH_ENTER = 200 // ≈4 检测帧
const HOLD_LAUGH_EXIT = 400 // ≈8 检测帧
const HOLD_NO_FACE = 1000

const RAIN_FADE_IN = 0.4 // 秒
const RAIN_FADE_OUT = 0.8

const BURST_COOLDOWN = 1.2 // 大烟花间隔
const SMALL_BURST_EVERY = 0.6 // 冷却期内的补发间隔
const RESIDUE_TIME = 1.5 // 情绪残留：离开大笑后余韵时长
const RESIDUE_BURST_EVERY = 0.5

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1)))
  return t * t * (3 - 2 * t)
}

export class ExpressionState {
  mode: Mode = 'idle'

  /** 雨量 0–1，已含缓入缓出 */
  rainRate = 0
  /** 本帧是否要发一发烟花（main 读完自行清空） */
  burstPending = false
  burstPower = 0
  burstScale = 1

  /** 引导进度条用：当前正在朝哪个触发靠近，以及进度 0–1 */
  guidePhase: 'smile' | 'laugh' | 'none' = 'smile'
  guideProgress = 0

  /** 里程碑：给引导文案判断走到第几步 */
  reachedSmile = false
  reachedLaugh = false
  reachedCollision = false

  private cfg: EffectConfig
  private tSmileEnter = 0
  private tSmileExit = 0
  private tLaughEnter = 0
  private tLaughExit = 0
  private tNoFace = 0

  private burstCooldown = 0
  private smallBurstTimer = 0
  private residue = 0
  private residueTimer = 0

  constructor(cfg: EffectConfig) {
    this.cfg = cfg
  }

  setConfig(cfg: EffectConfig): void {
    this.cfg = cfg
  }

  /** 手动触发（右下角按钮 / 调试键盘）：绕过表情直接进模式 */
  forceRain(seconds = 3): void {
    this.manualRain = Math.max(this.manualRain, seconds)
  }

  forceBurst(): void {
    this.burstPending = true
    this.burstPower = 0.75
    this.burstScale = 1
  }

  private manualRain = 0

  update(sig: Signals, dt: number): void {
    const c = this.cfg
    const ms = dt * 1000

    // ---- 无脸兜底 ----
    if (!sig.faceOk) {
      this.tNoFace += ms
      if (this.tNoFace >= HOLD_NO_FACE && this.mode !== 'idle') {
        this.leaveLaughing()
        this.mode = 'idle'
      }
    } else {
      this.tNoFace = 0
    }

    // ---- 转移 ----
    if (sig.faceOk) {
      switch (this.mode) {
        case 'idle':
          this.tSmileEnter = sig.smile >= c.smileEnter ? this.tSmileEnter + ms : 0
          if (this.tSmileEnter >= HOLD_SMILE_ENTER) {
            this.mode = 'smiling'
            this.reachedSmile = true
            this.tSmileEnter = 0
            this.tSmileExit = 0
          }
          break

        case 'smiling': {
          this.tSmileExit = sig.smile < c.smileExit ? this.tSmileExit + ms : 0
          if (this.tSmileExit >= HOLD_SMILE_EXIT) {
            this.mode = 'idle'
            this.tSmileExit = 0
            break
          }
          const laughing = sig.smile >= c.laughSmile && sig.jawOpen >= c.laughJaw
          this.tLaughEnter = laughing ? this.tLaughEnter + ms : 0
          if (this.tLaughEnter >= HOLD_LAUGH_ENTER) {
            this.enterLaughing(sig)
          }
          break
        }

        case 'laughing':
          this.tLaughExit = sig.jawOpen < c.laughExitJaw ? this.tLaughExit + ms : 0
          if (this.tLaughExit >= HOLD_LAUGH_EXIT) {
            this.leaveLaughing()
            this.mode = 'smiling'
            this.tLaughExit = 0
            this.tSmileExit = 0
          }
          break
      }
    }

    // ---- Laughing 内部的爆发节奏（事件，不是状态）----
    if (this.mode === 'laughing') {
      this.burstCooldown -= dt
      this.smallBurstTimer -= dt
      if (this.burstCooldown <= 0) {
        this.emit(sig.jawOpen, 1)
        this.burstCooldown = BURST_COOLDOWN
        this.smallBurstTimer = SMALL_BURST_EVERY
      } else if (this.smallBurstTimer <= 0) {
        this.emit(sig.jawOpen * 0.7, 0.35)
        this.smallBurstTimer = SMALL_BURST_EVERY
      }
    }

    // ---- 情绪残留：笑完之后烟花不立刻停，余韵里逐渐稀疏 ----
    if (this.residue > 0) {
      this.residue -= dt
      this.residueTimer -= dt
      if (this.residueTimer <= 0 && this.residue > 0) {
        const decay = this.residue / RESIDUE_TIME
        this.emit(0.4 * decay, 0.3 * decay)
        this.residueTimer = RESIDUE_BURST_EVERY
      }
    }

    // ---- 雨量：连续信号驱动，缓入缓出 ----
    if (this.manualRain > 0) this.manualRain -= dt
    const active = this.mode !== 'idle' || this.manualRain > 0
    const target = active
      ? this.manualRain > 0
        ? 0.7
        : smoothstep(c.smileExit, 0.8, sig.smile) * 0.95 + 0.05
      : 0
    const speed = target > this.rainRate ? dt / RAIN_FADE_IN : dt / RAIN_FADE_OUT
    const diff = target - this.rainRate
    this.rainRate += Math.abs(diff) <= speed ? diff : Math.sign(diff) * speed

    // ---- 引导进度条 ----
    if (this.mode === 'laughing') {
      this.guidePhase = 'none'
      this.guideProgress = 1
    } else if (this.mode === 'smiling') {
      this.guidePhase = 'laugh'
      this.guideProgress = Math.min(
        1,
        Math.min(sig.smile / c.laughSmile, sig.jawOpen / c.laughJaw),
      )
    } else {
      this.guidePhase = 'smile'
      this.guideProgress = Math.min(1, sig.smile / c.smileEnter)
    }
  }

  private enterLaughing(sig: Signals): void {
    this.mode = 'laughing'
    this.reachedLaugh = true
    this.tLaughEnter = 0
    this.residue = 0
    this.emit(sig.jawOpen, 1)
    this.burstCooldown = BURST_COOLDOWN
    this.smallBurstTimer = SMALL_BURST_EVERY
  }

  private leaveLaughing(): void {
    if (this.mode === 'laughing') {
      this.residue = RESIDUE_TIME
      this.residueTimer = RESIDUE_BURST_EVERY
    }
  }

  private emit(power: number, scale: number): void {
    this.burstPending = true
    this.burstPower = Math.min(1, Math.max(0.15, power))
    this.burstScale = scale
  }
}
