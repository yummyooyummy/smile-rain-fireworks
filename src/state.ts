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
// 退出阈值由进入阈值派生，永远比它低：用户怎么拖滑杆，迟滞都在，
// 不会出现「进 0.30 / 出 0.30」这种没有迟滞、临界处反复切换的组合。
const SMILE_EXIT_RATIO = 0.7
const LAUGH_EXIT_RATIO = 0.6

const HOLD_SMILE_ENTER = 600 // ≈12 检测帧
const HOLD_SMILE_EXIT = 500 // ≈10 检测帧
const HOLD_LAUGH_ENTER = 150 // ≈3 检测帧；大笑要比微笑先被判出来，否则「突然大笑」会先下雨
const HOLD_LAUGH_EXIT = 400 // ≈8 检测帧
const HOLD_NO_FACE = 1000

const RAIN_FADE_IN = 0.4 // 秒
const RAIN_CUT_OUT = 0.4
const RAIN_FADE_OUT = 0.8

const BURST_COOLDOWN = 0.9 // 大烟花间隔
const SMALL_BURST_EVERY = 0.4 // 冷却期内的补发间隔
const RESIDUE_TIME = 1.5 // 情绪残留：离开大笑后余韵时长
const RESIDUE_BURST_EVERY = 0.5

/**
 * 显示层幅度 = clamp(smile / smileEnter)，和 README 的口径一致；只影响显示，不改阈值、EMA、计时。
 * 仅在正式 Laughing 时归零。烟花余韵（residue）不挡条。
 */
export function smileBarAmp(mode: Mode, smile: number, smileEnter: number): number {
  if (mode === 'laughing') return 0
  return Math.min(1, Math.max(0, smile / (smileEnter || 1)))
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1)))
  return t * t * (3 - 2 * t)
}

export class ExpressionState {
  mode: Mode = 'idle'

  /** 雨量 0–1，已含缓入缓出 */
  rainRate = 0
  /** 本帧是否要发一发烟花（main 读完自行清空） */
  /** 这一帧要发射的烟花弹数；main 逐枚 launch 后清零 */
  burstCount = 0
  burstPower = 0
  burstScale = 1

  /** 业务：Idle 时微笑进入候选计时 0–1，Smiling=1，Laughing=0。不画条。 */
  smileProgress = 0
  /** 显示：见 smileBarAmp；只在 Laughing 归零，余韵不挡 */
  smileAmp = 0
  laughProgress = 0
  /** 进度条语义：charge = 未触发；active = 已触发；dim = 被另一根条的意图压住 */
  smileStatus: 'charge' | 'active' | 'dim' = 'charge'
  laughStatus: 'charge' | 'active' | 'dim' = 'charge'
  /** 微笑条弱化：此刻大笑正在进行（嘴张着且在笑，带 0.6× 退出迟滞）。只管透明度，不管幅度，不等退出防抖。 */
  smileDimmed = false
  private tSmileHold = 0

  private get smileExit(): number {
    return this.cfg.smileEnter * SMILE_EXIT_RATIO
  }

  private get laughExitJaw(): number {
    return this.cfg.laughJaw * LAUGH_EXIT_RATIO
  }
  /** 窄屏：一次只放一枚主烟花，靠节奏而不是数量——手机上人占画面大，三枚齐发会盖住脸 */
  private compact = false

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

  /** 重看引导：把三个「已经做到过」的标记清空，引导会从第一步重新走。 */
  resetGuide(): void {
    this.reachedSmile = false
    this.reachedLaugh = false
    this.reachedCollision = false
  }

  /** 退出回开始页：模式、雨量、残留烟花、手动触发全部清掉。 */
  reset(): void {
    this.mode = 'idle'
    this.rainRate = 0
    this.burstCount = 0
    this.burstPower = 0
    this.burstScale = 1
    this.smileProgress = 0
    this.smileAmp = 0
    this.laughProgress = 0
    this.smileStatus = 'charge'
    this.laughStatus = 'charge'
    this.smileDimmed = false
    this.resetGuide()
    this.tSmileEnter = 0
    this.tSmileExit = 0
    this.tLaughEnter = 0
    this.tLaughExit = 0
    this.tSmileHold = 0
    this.tNoFace = 0
    this.burstCooldown = 0
    this.smallBurstTimer = 0
    this.residue = 0
    this.residueTimer = 0
    this.manualRain = 0
  }

  forceRain(seconds = 3): void {
    this.manualRain = Math.max(this.manualRain, seconds)
  }

  setCompact(on: boolean): void {
    this.compact = on
  }

  forceBurst(): void {
    this.burstCount += this.compact ? 1 : 2
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
        case 'idle': {
          // 直接大笑也要能放烟花：不强迫用户先经过「微笑 600 ms」这一站。
          // 早期版本必须 Idle → Smiling → Laughing 串行走，用户一上来就大笑，
          // 会在 Smiling 的保持期里等一下，感觉「反应不过来」。
          const laughingNow = this.isLaughing(sig)
          this.tLaughEnter = laughingNow ? this.tLaughEnter + ms : 0
          if (this.tLaughEnter >= HOLD_LAUGH_ENTER) {
            this.reachedSmile = true
            this.tSmileEnter = 0
            this.tSmileExit = 0
            this.enterLaughing(sig)
            break
          }
          // 意图判断：嘴正在张开（jaw 已过大笑阈值的 60%）说明这多半是一次大笑的前半段，
          // 微笑的计时先停一停（最多 400 ms），别急着下雨。smile 信号总是比 jawOpen 先到，
          // 不等一下的话「突然大笑」永远会先变成微笑、先下雨、再放烟花。
          const opening = sig.jawOpen >= c.laughJaw * 0.6
          if (opening && this.tSmileHold < 400) {
            this.tSmileHold += ms
          } else {
            this.tSmileEnter = sig.smile >= c.smileEnter ? this.tSmileEnter + ms : 0
          }
          if (!opening) this.tSmileHold = 0
          if (this.tSmileEnter >= HOLD_SMILE_ENTER) {
            this.mode = 'smiling'
            this.reachedSmile = true
            this.tSmileEnter = 0
            this.tSmileExit = 0
            this.tSmileHold = 0
          }
          break
        }

        case 'smiling': {
          this.tSmileExit = sig.smile < this.smileExit ? this.tSmileExit + ms : 0
          if (this.tSmileExit >= HOLD_SMILE_EXIT) {
            this.mode = 'idle'
            this.tSmileExit = 0
            break
          }
          const laughing = this.isLaughing(sig)
          this.tLaughEnter = laughing ? this.tLaughEnter + ms : 0
          if (this.tLaughEnter >= HOLD_LAUGH_ENTER) {
            this.enterLaughing(sig)
          }
          break
        }

        case 'laughing':
          this.tLaughExit = sig.jawOpen < this.laughExitJaw ? this.tLaughExit + ms : 0
          if (this.tLaughExit >= HOLD_LAUGH_EXIT) {
            this.leaveLaughing()
            // 不继承大笑期间的满进度：清掉微笑计时，回待机。
            // 若仍满足微笑进入条件，idle 分支会按原规则重新累计 600 ms，不会直接跳满。
            this.mode = 'idle'
            this.tLaughExit = 0
            this.tSmileExit = 0
            this.tSmileEnter = 0
            this.tLaughEnter = 0
            this.tSmileHold = 0
          }
          break
      }
    }

    // ---- Laughing 内部的爆发节奏（事件，不是状态）----
    if (this.mode === 'laughing') {
      this.burstCooldown -= dt
      this.smallBurstTimer -= dt
      if (this.burstCooldown <= 0) {
        this.emit(sig.jawOpen, 1, this.compact ? 1 : 2)
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
    // 雨与烟花互斥：题目是两个并列的触发条件，一个状态一个效果。
    // 大笑时雨在 0.4 s 内淡出，只剩烟花；回到微笑再淡回来。
    // 叠加的话烟花碎片和雨丝一起往下掉，评审分不清哪个在碰头。
    const target =
      this.mode === 'laughing'
        ? 0
        : active
          ? this.manualRain > 0
            ? 0.7
            : smoothstep(this.smileExit, 0.8, sig.smile) * 0.95 + 0.05
          : 0
    const outSpeed = this.mode === 'laughing' ? dt / RAIN_CUT_OUT : dt / RAIN_FADE_OUT
    const speed = target > this.rainRate ? dt / RAIN_FADE_IN : outSpeed
    const diff = target - this.rainRate
    this.rainRate += Math.abs(diff) <= speed ? diff : Math.sign(diff) * speed

    // ---- 两根进度条：幅度 / 弱化分开 ----
    // 幅度：当前信号映射（Laughing 时微笑幅度为 0，这是已验收约束，不是弱化手段）。
    // 弱化（透明度）跟「此刻嘴是不是张着在笑」走，不跟状态机的 400 ms 退出防抖、也不跟烟花余韵：
    // 大笑一收、嘴一合，微笑条当帧亮回来、大笑条当帧变淡；防抖只管烟花什么时候停，不管条。
    // 进入方向用大笑阈值、退出方向用退出阈值（0.6×），和状态机同一套迟滞，所以「哈—哈—哈」不会闪。
    const laughingNow = this.mode === 'laughing'
    const laughLive = laughingNow ? sig.jawOpen >= this.laughExitJaw : this.isLaughing(sig)
    this.smileDimmed = laughLive
    // 微笑意图：已在微笑、微笑候选计时中、或微笑信号已过进入线（大笑刚收住、计时还没重新起步的那几帧）
    const smileIntent = !laughLive && (this.mode === 'smiling' || this.tSmileEnter > 0 || sig.smile >= c.smileEnter)
    this.smileStatus = laughLive ? 'dim' : this.mode === 'smiling' ? 'active' : 'charge'
    this.laughStatus = laughLive && laughingNow ? 'active' : smileIntent ? 'dim' : 'charge'
    this.smileAmp = smileBarAmp(this.mode, sig.smile, this.cfg.smileEnter)
    this.smileProgress =
      this.mode === 'smiling' ? 1 : laughingNow ? 0 : Math.min(1, this.tSmileEnter / HOLD_SMILE_ENTER)
    this.laughProgress = this.laughGate(sig)
  }

  /**
   * 大笑 = 嘴张到位（jawOpen ≥ laughJaw）且至少在笑（smile ≥ 进入阈值的 70%，这个门槛很低，
   * 只用来排除打哈欠和说话）。不再要求 smile ≥ 0.60——那条让「大笑」变成了「先笑得很开再张嘴」。
   */
  private isLaughing(sig: Signals): boolean {
    return sig.jawOpen >= this.cfg.laughJaw && sig.smile >= this.smileExit
  }

  /** 0–1，两个条件的最小值：任何一个不满足，条就不满 */
  private laughGate(sig: Signals): number {
    const c = this.cfg
    return Math.min(1, sig.jawOpen / c.laughJaw, sig.smile / this.smileExit)
  }

  private enterLaughing(sig: Signals): void {
    this.mode = 'laughing'
    this.reachedLaugh = true
    this.tLaughEnter = 0
    this.residue = 0
    this.emit(sig.jawOpen, 1, this.compact ? 1 : 3)
    this.burstCooldown = BURST_COOLDOWN
    this.smallBurstTimer = SMALL_BURST_EVERY
  }

  private leaveLaughing(): void {
    if (this.mode === 'laughing') {
      this.residue = RESIDUE_TIME
      this.residueTimer = RESIDUE_BURST_EVERY
    }
  }

  private emit(power: number, scale: number, n = 1): void {
    this.burstCount += n
    this.burstPower = Math.min(1, Math.max(0.15, power))
    this.burstScale = scale
  }
}
