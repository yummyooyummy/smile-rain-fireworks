// 粒子引擎：雨 + 烟花（升空 → 爆炸 → 下落）+ 头部椭圆碰撞。
//
// 性能约定（对应 CLAUDE.md）：
//  - 所有粒子数据放在预分配的 Float32Array（SoA）里，update/draw 循环内零分配。
//  - 发光用预渲染的径向渐变贴图 drawImage + 'lighter'，绝不用 shadowBlur。
//  - 碰撞只做「粒子 vs 一个椭圆」，没有粒子间碰撞，复杂度 O(n)。
//
// 两条视觉规则值得单独说明：
//  1. 雨不参与碰撞。早期版本让雨撞到椭圆就消失，结果脸上出现一个硬边的圆形空洞，非常假。
//  2. 烟花从画面底部升空、在高处炸开、粒子受重力下落——而不是从嘴里喷出来。
//     落到头上的粒子会分裂成更小的粒子向四周溅开。

import type { PersonCollider } from './segment'
import { TIERS, type EffectConfig, type Tier } from './config'

export interface HeadEllipse {
  cx: number
  cy: number
  rx: number
  ry: number
  /** 头部滚转角（弧度）。椭圆必须跟着头一起转，否则一歪头判定就整个偏掉。 */
  rot: number
}

/** 烟花调色板（暗调暖色，4 色，见设计定义 §4） */
const PALETTE: [number, number, number][] = [
  [240, 120, 90], // 珊瑚橙 #F0785A
  [233, 185, 90], // 暖金   #E9B95A
  [255, 243, 224], // 奶白   #FFF3E0
  [111, 195, 184], // 一点青 #6FC3B8
]
const RAIN_RGB: [number, number, number] = [191, 212, 242] // #BFD4F2

// 三层景深：远层又慢又细又淡，近层又快又长又亮，横向漂移也拉开，产生视差。
// 差异必须够大才看得出「景深」——差 20% 是看不出来的。
const RAIN_SPEED = [240, 520, 920] // px/s
const RAIN_ALPHA = [0.16, 0.4, 0.8]
const RAIN_WIDTH = [0.8, 1.6, 2.6]
const RAIN_DRIFT = [10, 24, 44] // px/s 横向漂移
const RAIN_STREAK = 0.032 // 拖尾长度 = 速度 × 这个系数
// 雨的尺寸按屏幕短边缩放：同样 2.6px 粗、30px 长的雨丝，在 1440 宽的桌面上是雨，
// 在 390 宽的手机上像一根根牙签。不做两套参数，做一个连续的缩放系数。
const RAIN_REF_SIZE = 820
const RAIN_LAYER_WEIGHT = [0.5, 0.32, 0.18] // 远层最多，近层最少

const GRAVITY = 300 // px/s²（比真实重力慢，粒子才有时间飘落到人身上再碰撞）
// 阻力改为与速度平方成正比（Norman 2018 对真实烟花星的拟合：v(t) = v0 / (1 + k·v0·t)）。
// 直觉版本 v *= 0.985 是线性衰减，快慢粒子一样减速，看起来「匀速散开的彩点」；
// 真实烟花前 0.5 s 扩得最猛、然后骤然变慢开始飘落——这正是 v² 阻力的形状。
const SPARK_K = 0.01 // 1/px；v0≈900 px/s 时 k·v0≈9/s：0.5 s 内扩到约 170 px，2 s 约 290 px
const FADE_FILL = 'rgba(0,0,0,0.18)' // 烟花层每帧压暗的比例：越小拖尾越长
const ROCKET_TRAIL = 14 // 烟花弹尾焰记的位置数
const TWINKLE_RATE = 0.35 // 35% 的爆炸粒子会闪烁
const CRACKLE_RATE = 0 // 二次崩裂关掉：粒子快落完时「再爆一下」抢了飘落熄灭的节奏（Yuqing 试过后定的）
const FLASH_MS = 50
const PULSE_MS = 120
const PULSE_COOLDOWN_MS = 200
const MAX_ROCKETS = 8
const MAX_FLASH = 6
const FLASH_LIFE_MS = 220

/** 把 [r,g,b] 按色相偏移旋转 */
function rotateHue(rgb: [number, number, number], deg: number, out: Float32Array, i: number): void {
  if (deg === 0) {
    out[i] = rgb[0]
    out[i + 1] = rgb[1]
    out[i + 2] = rgb[2]
    return
  }
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const [r, g, b] = rgb
  out[i] = clamp255(
    (0.213 + cos * 0.787 - sin * 0.213) * r +
      (0.715 - cos * 0.715 - sin * 0.715) * g +
      (0.072 - cos * 0.072 + sin * 0.928) * b,
  )
  out[i + 1] = clamp255(
    (0.213 - cos * 0.213 + sin * 0.143) * r +
      (0.715 + cos * 0.285 + sin * 0.14) * g +
      (0.072 - cos * 0.072 - sin * 0.283) * b,
  )
  out[i + 2] = clamp255(
    (0.213 - cos * 0.213 - sin * 0.787) * r +
      (0.715 - cos * 0.715 + sin * 0.715) * g +
      (0.072 + cos * 0.928 + sin * 0.072) * b,
  )
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function pickLayer(): number {
  const r = Math.random()
  if (r < RAIN_LAYER_WEIGHT[0]) return 0
  if (r < RAIN_LAYER_WEIGHT[0] + RAIN_LAYER_WEIGHT[1]) return 1
  return 2
}

export interface EffectStats {
  rainAlive: number
  sparkAlive: number
  rocketAlive: number
  collisions: number
}

export class Effects {
  private ctx: CanvasRenderingContext2D
  /** 雨的独立图层（人像遮挡开启时雨画在人身后） */
  private rainCtx: CanvasRenderingContext2D | null = null
  private nrm = new Float32Array(2)
  private w = 0
  private h = 0

  private cfg: EffectConfig
  private tier: Tier

  // ---- 雨池（SoA）----
  private rx!: Float32Array
  private ry!: Float32Array
  private rvy!: Float32Array
  private rvx!: Float32Array
  private rlen!: Float32Array
  private rlayer!: Uint8Array
  private rAlive!: Uint8Array
  private rainCap = 0
  private rainCursor = 0
  private rainAlive = 0
  private rainBudget = 0

  // ---- 火花池（SoA）----
  private sx!: Float32Array
  private sy!: Float32Array
  private spx!: Float32Array
  private spy!: Float32Array
  private svx!: Float32Array
  private svy!: Float32Array
  private slife!: Float32Array
  private smax!: Float32Array
  private ssize!: Float32Array
  private scolor!: Uint8Array
  private sflash!: Float32Array
  private sgen!: Uint8Array // 0 = 爆炸粒子（撞头会分裂）；1 = 分裂出来的碎片（不再分裂）
  private stw!: Float32Array // 闪烁频率（Hz），0 = 不闪
  private sph!: Float32Array // 闪烁相位
  private scr!: Uint8Array // 1 = 还会二次崩裂
  private sAlive!: Uint8Array
  private sparkCap = 0
  private sparkCursor = 0
  private sparkAlive = 0

  // ---- 升空的烟花弹（数量很少，独立小池）----
  private kx = new Float32Array(MAX_ROCKETS)
  private ky = new Float32Array(MAX_ROCKETS)
  private kvx = new Float32Array(MAX_ROCKETS)
  private kvy = new Float32Array(MAX_ROCKETS)
  private kay = new Float32Array(MAX_ROCKETS)
  private kpower = new Float32Array(MAX_ROCKETS)
  private kscale = new Float32Array(MAX_ROCKETS)
  private kcolor = new Uint8Array(MAX_ROCKETS)
  private khx = new Float32Array(MAX_ROCKETS * ROCKET_TRAIL)
  private khy = new Float32Array(MAX_ROCKETS * ROCKET_TRAIL)
  private khn = new Uint8Array(MAX_ROCKETS)
  private khi = new Uint8Array(MAX_ROCKETS)
  private kAlive = new Uint8Array(MAX_ROCKETS)
  private rocketAlive = 0

  // ---- 炸开瞬间的闪光：一颗迅速膨胀、迅速熄灭的大光球 ----
  private fx_ = new Float32Array(MAX_FLASH)
  private fy_ = new Float32Array(MAX_FLASH)
  private ft_ = new Float32Array(MAX_FLASH) // 剩余 ms，0 = 空
  private fsize = new Float32Array(MAX_FLASH)
  private fcolor = new Uint8Array(MAX_FLASH)

  // ---- 发光贴图 ----
  private glow: HTMLCanvasElement[] = []
  private glowSize = 64

  private palette = new Float32Array(PALETTE.length * 3)
  private rainColor = new Float32Array(3)
  private appliedHue = NaN
  /** 在 applyPalette 里预拼好，draw 循环只读，避免每帧模板字符串 */
  private rainStroke: string[] = ['', '', '']
  private paletteStroke: string[] = ['', '', '', '']
  private pulseStroke = 'rgb(255,238,214)'

  private rainRate = 0
  private headPulse = 0
  private headPulseCooldown = 0
  private collisions = 0

  constructor(canvas: HTMLCanvasElement, cfg: EffectConfig, tier: Tier) {
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!ctx) throw new Error('Canvas 2D not available')
    this.ctx = ctx
    this.cfg = cfg
    this.tier = tier
    this.applyPalette()
    this.allocRain(TIERS.high.rainMax)
    this.allocSpark(TIERS.high.sparkPool)
    this.buildGlow()
  }

  // ---------- 生命周期 ----------

  private dpr = 1
  private rainK = 1

  resize(w: number, h: number, dpr: number): void {
    this.w = w
    this.h = h
    this.dpr = dpr
    this.rainK = Math.min(1, Math.max(0.45, Math.min(w, h) / RAIN_REF_SIZE))
    this.fit(this.ctx)
    if (this.rainCtx) this.fit(this.rainCtx)
  }

  private fit(ctx: CanvasRenderingContext2D): void {
    const c = ctx.canvas
    c.width = Math.round(this.w * this.dpr)
    c.height = Math.round(this.h * this.dpr)
    c.style.width = `${this.w}px`
    c.style.height = `${this.h}px`
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  setConfig(cfg: EffectConfig): void {
    this.cfg = cfg
    this.applyPalette()
  }

  setTier(tier: Tier): void {
    if (tier.name === this.tier.name) return
    this.tier = tier
  }

  get currentTier(): Tier {
    return this.tier
  }

  get ctx2d(): CanvasRenderingContext2D {
    return this.ctx
  }

  /** 人像遮挡开启时，雨画到人身后那层；关闭时画回同一张 canvas。 */
  setRainLayer(canvas: HTMLCanvasElement | null): void {
    this.rainCtx = canvas ? (canvas.getContext('2d') as CanvasRenderingContext2D) : null
    if (this.rainCtx) this.fit(this.rainCtx)
  }

  /** 退出回开始页时清空所有粒子。只清 alive 标志，不重新分配。 */
  clear(): void {
    this.ctx.globalCompositeOperation = 'source-over'
    this.ctx.clearRect(0, 0, this.w, this.h)
    this.rAlive.fill(0)
    this.sAlive.fill(0)
    this.kAlive.fill(0)
    this.ft_.fill(0)
    this.rainAlive = 0
    this.sparkAlive = 0
    this.rocketAlive = 0
  }

  setRainRate(rate: number): void {
    this.rainRate = rate < 0 ? 0 : rate > 1 ? 1 : rate
  }

  get stats(): EffectStats {
    return {
      rainAlive: this.rainAlive,
      sparkAlive: this.sparkAlive,
      rocketAlive: this.rocketAlive,
      collisions: this.collisions,
    }
  }

  // ---------- 分配 ----------

  private allocRain(cap: number): void {
    this.rainCap = cap
    this.rx = new Float32Array(cap)
    this.ry = new Float32Array(cap)
    this.rvy = new Float32Array(cap)
    this.rvx = new Float32Array(cap)
    this.rlen = new Float32Array(cap)
    this.rlayer = new Uint8Array(cap)
    this.rAlive = new Uint8Array(cap)
    this.rainAlive = 0
    this.rainCursor = 0
  }

  private allocSpark(cap: number): void {
    this.sparkCap = cap
    this.sx = new Float32Array(cap)
    this.sy = new Float32Array(cap)
    this.spx = new Float32Array(cap)
    this.spy = new Float32Array(cap)
    this.svx = new Float32Array(cap)
    this.svy = new Float32Array(cap)
    this.slife = new Float32Array(cap)
    this.smax = new Float32Array(cap)
    this.ssize = new Float32Array(cap)
    this.scolor = new Uint8Array(cap)
    this.sflash = new Float32Array(cap)
    this.sgen = new Uint8Array(cap)
    this.stw = new Float32Array(cap)
    this.sph = new Float32Array(cap)
    this.scr = new Uint8Array(cap)
    this.sAlive = new Uint8Array(cap)
    this.sparkAlive = 0
    this.sparkCursor = 0
  }

  private applyPalette(): void {
    if (this.appliedHue === this.cfg.hueShift) return
    this.appliedHue = this.cfg.hueShift
    for (let i = 0; i < PALETTE.length; i++) {
      rotateHue(PALETTE[i], this.cfg.hueShift, this.palette, i * 3)
      const r = this.palette[i * 3] | 0
      const g = this.palette[i * 3 + 1] | 0
      const b = this.palette[i * 3 + 2] | 0
      this.paletteStroke[i] = 'rgb(' + r + ',' + g + ',' + b + ')'
    }
    rotateHue(RAIN_RGB, this.cfg.hueShift * 0.3, this.rainColor, 0)
    const rr = this.rainColor[0] | 0
    const rg = this.rainColor[1] | 0
    const rb = this.rainColor[2] | 0
    for (let layer = 0; layer < 3; layer++) {
      this.rainStroke[layer] = 'rgba(' + rr + ',' + rg + ',' + rb + ',' + RAIN_ALPHA[layer] + ')'
    }
    this.buildGlow()
  }

  private buildGlow(): void {
    const size = this.glowSize
    this.glow = []
    for (let i = 0; i < PALETTE.length; i++) {
      const c = document.createElement('canvas')
      c.width = c.height = size
      const g = c.getContext('2d')!
      const r = this.palette[i * 3] | 0
      const gg = this.palette[i * 3 + 1] | 0
      const b = this.palette[i * 3 + 2] | 0
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
      grad.addColorStop(0, `rgba(${r},${gg},${b},1)`)
      grad.addColorStop(0.35, `rgba(${r},${gg},${b},0.55)`)
      grad.addColorStop(1, `rgba(${r},${gg},${b},0)`)
      g.fillStyle = grad
      g.fillRect(0, 0, size, size)
      this.glow.push(c)
    }
    const wcv = document.createElement('canvas')
    wcv.width = wcv.height = size
    const wg = wcv.getContext('2d')!
    const wgrad = wg.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    wgrad.addColorStop(0, 'rgba(255,255,255,1)')
    wgrad.addColorStop(0.4, 'rgba(255,255,255,0.6)')
    wgrad.addColorStop(1, 'rgba(255,255,255,0)')
    wg.fillStyle = wgrad
    wg.fillRect(0, 0, size, size)
    this.glow.push(wcv)
  }

  // ---------- 发射 ----------

  /**
   * 从画面底部发射一枚烟花弹，升到高处再炸开。
   * power 0–1 控制爆炸规模，scale 控制这一发是「大烟花」还是补发的小烟花。
   */
  launch(power: number, scale = 1, head: HeadEllipse | null = null): void {
    let idx = -1
    for (let i = 0; i < MAX_ROCKETS; i++) {
      if (!this.kAlive[i]) {
        idx = i
        break
      }
    }
    if (idx < 0) return // 同屏烟花弹已满，直接丢弃

    const y0 = this.h + 12
    let x: number
    let targetY: number
    if (head) {
      // 整个背景均匀升空（Yuqing 决定，不再只在脸两侧）；炸点高度仍参照头：
      // 落在头顶上方 0.6–1.8 倍头高处，粒子飘落时才会经过头部。
      x = this.w * (0.1 + Math.random() * 0.8)
      // 炸点离头远一点：太近的话炸开瞬间整片粒子一起砸在头上，碰撞密得像下冰雹。
      // 远了之后只有飘落的那部分会经过头，稀疏、可辨认。
      targetY = Math.max(this.h * 0.06, head.cy - head.ry * (1.6 + Math.random() * 1.6))
      if (Math.abs(x - head.cx) < head.rx * 1.6) targetY = Math.min(targetY, head.cy - head.ry * 3.2)
    } else {
      x = this.w * (0.12 + Math.random() * 0.76)
      targetY = this.h * (0.12 + Math.random() * 0.26) * (scale < 0.6 ? 1.5 : 1)
    }
    const riseTime = (0.5 + Math.random() * 0.22) * (scale < 0.6 ? 0.75 : 1)
    const d = y0 - targetY
    const v0 = (2 * d) / riseTime // 匀减速到顶点

    this.kAlive[idx] = 1
    this.rocketAlive++
    this.kx[idx] = x
    this.ky[idx] = y0
    this.kvx[idx] = (Math.random() - 0.5) * 70
    this.kvy[idx] = -v0
    this.kay[idx] = v0 / riseTime
    this.kpower[idx] = power
    this.kscale[idx] = scale
    this.kcolor[idx] = (Math.random() * PALETTE.length) | 0
    this.khn[idx] = 0
    this.khi[idx] = 0
  }

  private addFlash(x: number, y: number, color: number, size: number): void {
    let idx = 0
    for (let i = 0; i < MAX_FLASH; i++) {
      if (this.ft_[i] <= 0) {
        idx = i
        break
      }
    }
    this.fx_[idx] = x
    this.fy_[idx] = y
    this.ft_[idx] = FLASH_LIFE_MS
    this.fsize[idx] = size
    this.fcolor[idx] = color
  }

  /** 在指定位置直接炸开（升空到顶点后由 update 调用；也可单独用于调试） */
  burst(x: number, y: number, power: number, scale = 1): void {
    const base = Math.min(this.cfg.fireworkCount, this.tier.sparkPerBurst)
    const count = Math.max(12, Math.round(base * scale * (0.55 + 0.45 * power)))
    // v² 阻力下初速要给足，前 0.3 s 的猛扩就是烟花的「炸」感
    const speed = (430 + 510 * power) * this.cfg.burstScale
    const hue = (Math.random() * PALETTE.length) | 0
    this.addFlash(x, y, hue, 0.7 + 0.5 * power * scale)
    for (let i = 0; i < count; i++) {
      const idx = this.acquireSpark()
      if (idx < 0) break
      const ang = Math.random() * Math.PI * 2
      // 真实烟花是一个球壳投影到平面上：外圈密、中心稀。取 u ∈ [-1,1] 均匀，
      // 速度 = speed·sqrt(1-u²) 就是球壳的投影分布；再掺 25% 填满内部，避免中间空。
      const u = Math.random() * 2 - 1
      const sp = Math.random() < 0.75 ? speed * Math.sqrt(1 - u * u) : speed * (0.15 + Math.random() * 0.5)
      this.sx[idx] = x
      this.sy[idx] = y
      this.spx[idx] = x
      this.spy[idx] = y
      this.svx[idx] = Math.cos(ang) * sp
      this.svy[idx] = Math.sin(ang) * sp
      const life = 1.4 + Math.random() * 1.2
      this.slife[idx] = life
      this.smax[idx] = life
      // 参考视频里的烟花是几百颗细小的亮点，不是几十颗大光球
      this.ssize[idx] = 3.5 + Math.random() * 4.5 * (0.6 + power * 0.4)
      // 一发烟花以一个主色为主，掺少量其它色，比纯随机好看
      this.scolor[idx] = Math.random() < 0.75 ? hue : (Math.random() * PALETTE.length) | 0
      this.sflash[idx] = 0
      this.sgen[idx] = 0
      this.stw[idx] = Math.random() < TWINKLE_RATE ? 6 + Math.random() * 9 : 0
      this.sph[idx] = Math.random() * 6.283
      this.scr[idx] = Math.random() < CRACKLE_RATE ? 1 : 0
    }
  }

  private inEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number, cosR: number, sinR: number): boolean {
    const dx = x - cx
    const dy = y - cy
    const lx = dx * cosR + dy * sinR
    const ly = -dx * sinR + dy * cosR
    const u = lx / rx
    const v = ly / ry
    return u * u + v * v < 1
  }

  /** 二次崩裂：一颗星燃尽前再炸出几颗小星，烟花才「活」——不是均匀熄灭，而是层层迸发 */
  private crackle(i: number): void {
    const n = 3 + ((Math.random() * 3) | 0)
    for (let k = 0; k < n; k++) {
      const idx = this.acquireSpark()
      if (idx < 0) break
      const ang = Math.random() * 6.283
      const sp = 40 + Math.random() * 90
      this.sx[idx] = this.sx[i]
      this.sy[idx] = this.sy[i]
      this.spx[idx] = this.sx[i]
      this.spy[idx] = this.sy[i]
      this.svx[idx] = this.svx[i] * 0.4 + Math.cos(ang) * sp
      this.svy[idx] = this.svy[i] * 0.4 + Math.sin(ang) * sp
      const life = 0.25 + Math.random() * 0.35
      this.slife[idx] = life
      this.smax[idx] = life
      this.ssize[idx] = this.ssize[i] * (0.3 + Math.random() * 0.25)
      this.scolor[idx] = Math.random() < 0.6 ? this.scolor[i] : 2
      this.sflash[idx] = FLASH_MS
      this.sgen[idx] = 1
      this.stw[idx] = 12 + Math.random() * 10
      this.sph[idx] = Math.random() * 6.283
      this.scr[idx] = 0
    }
  }

  private acquireSpark(): number {
    const cap = Math.min(this.sparkCap, this.tier.sparkPool)
    // 池满时提前返回。否则每次发射都要把整个池扫一遍才发现没位置，
    // 满负荷下就是每帧几万次空转。
    if (this.sparkAlive >= cap) return -1
    for (let n = 0; n < cap; n++) {
      const i = this.sparkCursor
      this.sparkCursor = (this.sparkCursor + 1) % cap
      if (!this.sAlive[i]) {
        this.sAlive[i] = 1
        this.sparkAlive++
        return i
      }
    }
    return -1
  }

  private acquireRain(): number {
    const cap = Math.min(this.rainCap, Math.round(this.tier.rainMax * this.cfg.rainMax))
    if (cap <= 0 || this.rainAlive >= cap) return -1
    for (let n = 0; n < cap; n++) {
      const i = this.rainCursor
      this.rainCursor = (this.rainCursor + 1) % cap
      if (!this.rAlive[i]) {
        this.rAlive[i] = 1
        this.rainAlive++
        return i
      }
    }
    return -1
  }

  private spawnRain(): void {
    const idx = this.acquireRain()
    if (idx < 0) return
    const layer = pickLayer()
    this.rlayer[idx] = layer
    this.rx[idx] = Math.random() * (this.w + 160) - 80
    this.ry[idx] = -30 - Math.random() * 160
    const k = this.rainK
    const sp = RAIN_SPEED[layer] * (0.9 + Math.random() * 0.2) * k
    this.rvy[idx] = sp
    this.rvx[idx] = RAIN_DRIFT[layer] * (0.8 + Math.random() * 0.4) * k
    this.rlen[idx] = sp * RAIN_STREAK
  }

  // ---------- 更新 ----------

  update(dt: number, head: HeadEllipse | null, person: PersonCollider | null = null): void {
    this.collisions = 0
    const dtMs = dt * 1000

    if (this.headPulse > 0) this.headPulse -= dtMs
    for (let i = 0; i < MAX_FLASH; i++) if (this.ft_[i] > 0) this.ft_[i] -= dtMs
    if (this.headPulseCooldown > 0) this.headPulseCooldown -= dtMs

    const hasHead = head !== null
    const cx = hasHead ? head!.cx : 0
    const cy = hasHead ? head!.cy : 0
    const rx = hasHead ? head!.rx : 1
    const ry = hasHead ? head!.ry : 1
    // 头部局部坐标系：先把粒子旋转进椭圆自己的坐标系再判定，
    // 这样歪头、侧头时碰撞体跟着转，而不是永远正着放。
    const rot = hasHead ? head!.rot : 0
    const cosR = Math.cos(rot)
    const sinR = Math.sin(rot)
    const bottom = this.h + 60

    // --- 烟花弹升空 ---
    for (let i = 0; i < MAX_ROCKETS; i++) {
      if (!this.kAlive[i]) continue
      const hi = this.khi[i]
      this.khx[i * ROCKET_TRAIL + hi] = this.kx[i]
      this.khy[i * ROCKET_TRAIL + hi] = this.ky[i]
      this.khi[i] = (hi + 1) % ROCKET_TRAIL
      if (this.khn[i] < ROCKET_TRAIL) this.khn[i]++
      this.kvy[i] += this.kay[i] * dt
      this.kx[i] += this.kvx[i] * dt
      this.ky[i] += this.kvy[i] * dt
      // 到达顶点（或飞出画面顶部）就炸开；顶点落在人身上就再推一把继续往上，别在脸前面炸
      if (this.kvy[i] >= 0 || this.ky[i] < 8) {
        const onPerson =
          this.ky[i] > 30 &&
          (person
            ? person.isPerson(this.kx[i], this.ky[i])
            : hasHead && this.inEllipse(this.kx[i], this.ky[i], cx, cy, rx, ry, cosR, sinR))
        if (onPerson) {
          this.kvy[i] = -260
          this.kay[i] = 180
          continue
        }
        this.burst(this.kx[i], this.ky[i], this.kpower[i], this.kscale[i])
        this.kAlive[i] = 0
        this.rocketAlive--
      }
    }

    // --- 雨：生成 ---
    const targetRate = this.rainRate * this.tier.rainMax * this.cfg.rainMax * 1.7
    this.rainBudget += targetRate * dt
    if (this.rainBudget > 60) this.rainBudget = 60 // 配额封顶，避免掉帧后一次性喷一大坨
    while (this.rainBudget >= 1) {
      this.rainBudget -= 1
      this.spawnRain()
    }

    // --- 雨：积分（不参与碰撞）---
    const rainCap = this.rainCap
    for (let i = 0; i < rainCap; i++) {
      if (!this.rAlive[i]) continue
      this.ry[i] += this.rvy[i] * dt
      this.rx[i] += this.rvx[i] * dt
      if (this.ry[i] > bottom || this.rx[i] > this.w + 90) {
        this.rAlive[i] = 0
        this.rainAlive--
        continue
      }
      // 雨不参与碰撞：题目只要求烟花粒子撞头。雨在人身后（人像遮挡）就够了。
    }

    // --- 火花：积分 + 碰撞 ---
    const rest = this.cfg.restitution
    const sparkCap = this.sparkCap
    for (let i = 0; i < sparkCap; i++) {
      if (!this.sAlive[i]) continue
      this.slife[i] -= dt
      if (this.slife[i] <= 0) {
        this.sAlive[i] = 0
        this.sparkAlive--
        continue
      }
      if (this.sflash[i] > 0) this.sflash[i] -= dtMs

      this.spx[i] = this.sx[i]
      this.spy[i] = this.sy[i]
      // v² 阻力：ds = -k·s²·dt → s' = s / (1 + k·s·dt)，快的减得狠、慢的几乎不减
      const spd = Math.hypot(this.svx[i], this.svy[i])
      if (spd > 1) {
        const f = 1 / (1 + SPARK_K * spd * dt)
        this.svx[i] *= f
        this.svy[i] *= f
      }
      this.svy[i] += GRAVITY * dt
      this.sx[i] += this.svx[i] * dt
      this.sy[i] += this.svy[i] * dt

      // 燃尽前 30% 时二次崩裂一次
      if (this.scr[i] && this.slife[i] < this.smax[i] * 0.3) {
        this.scr[i] = 0
        this.crackle(i)
      }

      if (this.sx[i] < -80 || this.sx[i] > this.w + 80 || this.sy[i] > bottom) {
        this.sAlive[i] = 0
        this.sparkAlive--
        continue
      }

      if (person) {
        // 从外面进到人像里的那一帧才算撞上；在人像里出生的粒子（近脸炸开）放它出去
        if (!person.isPerson(this.sx[i], this.sy[i]) || person.isPerson(this.spx[i], this.spy[i])) continue
        person.normal(this.sx[i], this.sy[i], this.nrm)
        this.sx[i] = this.spx[i]
        this.sy[i] = this.spy[i]
        this.resolveHit(i, this.nrm[0], this.nrm[1], rest)
        continue
      }

      if (!hasHead) continue
      const dx = this.sx[i] - cx
      const dy = this.sy[i] - cy
      const lx = dx * cosR + dy * sinR
      const ly = -dx * sinR + dy * cosR
      const u = lx / rx
      const v = ly / ry
      const d2 = u * u + v * v
      if (d2 >= 1 || d2 === 0) continue

      // 在椭圆内 → 沿局部坐标推回边界，算出法线后再旋转回世界坐标
      const s = 1 / Math.sqrt(d2)
      const bx = u * s * rx
      const by = v * s * ry
      this.sx[i] = cx + bx * cosR - by * sinR
      this.sy[i] = cy + bx * sinR + by * cosR
      let lnx = u / rx
      let lny = v / ry
      const nl = Math.hypot(lnx, lny) || 1
      lnx /= nl
      lny /= nl
      const nx = lnx * cosR - lny * sinR
      const ny = lnx * sinR + lny * cosR

      this.resolveHit(i, nx, ny, rest)
    }
  }

  /** 撞上之后：母粒子分裂、碎片反弹闪白，两条路径（椭圆 / 人像遮罩）共用。 */
  private resolveHit(i: number, nx: number, ny: number, rest: number): void {
    this.collisions++
    if (this.headPulseCooldown <= 0) {
      this.headPulse = PULSE_MS
      this.headPulseCooldown = PULSE_COOLDOWN_MS
    }
    // 撞人 = 弹开 + 闪白 + 缩小，不分裂（分裂版本在余辉层上太抢戏，Yuqing 试过后定的）
    if (this.sgen[i] === 0) {
      this.sgen[i] = 1
      this.ssize[i] *= 0.7
    }
    const vn = this.svx[i] * nx + this.svy[i] * ny
    if (vn < 0) {
      this.svx[i] -= (1 + rest) * vn * nx
      this.svy[i] -= (1 + rest) * vn * ny
      this.svx[i] *= 0.8
      this.svy[i] *= 0.8
    }
    this.sflash[i] = FLASH_MS
  }

  // ---------- 绘制 ----------

  draw(head: HeadEllipse | null): void {
    // 烟花层不清屏：把上一帧整体压暗 18%，每颗火花自然留下一条渐隐的光迹。
    // 这是 Canvas 烟花的经典做法，比逐颗画折线拖尾便宜得多、也好看得多——
    // 光迹是发光贴图叠加出来的，有粗细和亮度的自然衰减，不是一根硬线。
    const ctx0 = this.ctx
    ctx0.globalCompositeOperation = 'destination-out'
    ctx0.globalAlpha = 1
    ctx0.fillStyle = FADE_FILL
    ctx0.fillRect(0, 0, this.w, this.h)
    if (this.rainCtx) this.rainCtx.clearRect(0, 0, this.w, this.h)
    // 雨画到人身后那层（若开启），其余都在最前面那层
    const rctx = this.rainCtx ?? this.ctx
    this.drawRain(rctx)
    this.drawRockets(rctx)
    this.drawFront(head)
  }

  private drawRain(ctx: CanvasRenderingContext2D): void {
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineCap = 'round'
    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath()
      ctx.strokeStyle = this.rainStroke[layer]
      ctx.lineWidth = Math.max(0.6, RAIN_WIDTH[layer] * this.rainK)
      let any = false
      const tail = RAIN_DRIFT[layer] * RAIN_STREAK * this.rainK
      for (let i = 0; i < this.rainCap; i++) {
        if (!this.rAlive[i] || this.rlayer[i] !== layer) continue
        const x = this.rx[i]
        const y = this.ry[i]
        ctx.moveTo(x - tail, y - this.rlen[i])
        ctx.lineTo(x, y)
        any = true
      }
      if (any) ctx.stroke()
    }
  }

  /** 升空中的烟花弹：一个亮点 + 一条尾焰。画在人身后那层——它是从背景升起来的 */
  private drawRockets(ctx: CanvasRenderingContext2D): void {
    const glow = this.glow
    const whiteIdx = glow.length - 1
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < MAX_ROCKETS; i++) {
      if (!this.kAlive[i]) continue
      // 彗尾：沿着最近 14 个位置画一串越来越小、越来越淡的光点，还随机抖一点火星
      const n = this.khn[i]
      const base = i * ROCKET_TRAIL
      let idx = (this.khi[i] - n + ROCKET_TRAIL) % ROCKET_TRAIL
      for (let k = 0; k < n; k++) {
        const f = (k + 1) / n // 0 → 1，越接近弹头越亮
        const r = 2 + 7 * f
        ctx.globalAlpha = 0.12 + 0.5 * f * f
        ctx.drawImage(glow[this.kcolor[i]], this.khx[base + idx] - r, this.khy[base + idx] - r, r * 2, r * 2)
        idx = (idx + 1) % ROCKET_TRAIL
      }
      ctx.globalAlpha = 1
      ctx.drawImage(glow[whiteIdx], this.kx[i] - 7, this.ky[i] - 7, 14, 14)
      ctx.globalAlpha = 0.9
      ctx.drawImage(glow[this.kcolor[i]], this.kx[i] - 13, this.ky[i] - 13, 26, 26)
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawFront(head: HeadEllipse | null): void {
    const ctx = this.ctx
    // 头部微光脉冲：碰撞发生时沿椭圆边缘亮一圈
    if (head && this.headPulse > 0) {
      const t = this.headPulse / PULSE_MS
      ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      ctx.ellipse(head.cx, head.cy, head.rx, head.ry, head.rot, 0, Math.PI * 2)
      ctx.globalAlpha = 0.32 * t
      ctx.strokeStyle = this.pulseStroke
      ctx.lineWidth = 2 + 7 * (1 - t)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    ctx.globalCompositeOperation = 'lighter'
    const glow = this.glow
    const whiteIdx = glow.length - 1

    // 炸开闪光：先白后彩，半径快速膨胀、亮度快速衰减
    for (let i = 0; i < MAX_FLASH; i++) {
      if (this.ft_[i] <= 0) continue
      const t = this.ft_[i] / FLASH_LIFE_MS // 1 → 0
      const r = (60 + 240 * (1 - t)) * this.fsize[i]
      ctx.globalAlpha = 0.55 * t * t
      ctx.drawImage(glow[this.fcolor[i]], this.fx_[i] - r, this.fy_[i] - r, r * 2, r * 2)
      const rw = r * 0.45
      ctx.globalAlpha = 0.8 * t * t * t
      ctx.drawImage(glow[whiteIdx], this.fx_[i] - rw, this.fy_[i] - rw, rw * 2, rw * 2)
    }

    // 火花
    const now = performance.now() * 0.001
    for (let i = 0; i < this.sparkCap; i++) {
      if (!this.sAlive[i]) continue
      const t = this.slife[i] / this.smax[i]
      let alpha = t * Math.sqrt(t) // 比 t² 衰减慢，火花亮得久一点
      // 闪烁：亮度在 0.45–1 之间按各自频率与相位起伏，避免同步闪
      if (this.stw[i] > 0) alpha *= 0.72 + 0.28 * Math.sin(now * this.stw[i] * 6.283 + this.sph[i])
      const size = this.ssize[i] * (0.5 + 0.5 * t) * 2.6
      const half = size / 2
      const c = this.scolor[i]
      const img = this.sflash[i] > 0 ? glow[whiteIdx] : glow[c]

      ctx.globalAlpha = alpha * 0.85
      ctx.drawImage(img, this.sx[i] - half, this.sy[i] - half, size, size)
      // 余晖：刚炸开的 15% 时间里核心偏白（高温），之后回到本色，再随 alpha 暗下去
      if (t > 0.85 && this.sflash[i] <= 0) {
        ctx.globalAlpha = alpha * ((t - 0.85) / 0.15) * 0.8
        ctx.drawImage(glow[whiteIdx], this.sx[i] - half * 0.6, this.sy[i] - half * 0.6, size * 0.6, size * 0.6)
      }
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  /** 调试用：把头部椭圆画出来 */
  drawDebugHead(head: HeadEllipse): void {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = 'rgba(111,195,184,0.7)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.ellipse(head.cx, head.cy, head.rx, head.ry, head.rot, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}
