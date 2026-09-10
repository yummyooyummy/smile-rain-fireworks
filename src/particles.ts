// 粒子引擎：雨 + 烟花（升空 → 爆炸 → 下落）+ 头部椭圆碰撞。
//
// 性能约定（对应 CLAUDE.md）：
//  - 所有粒子数据放在预分配的 Float32Array（SoA）里，update/draw 循环内零分配。
//  - 发光用预渲染的径向渐变贴图 drawImage + 'lighter'，绝不用 shadowBlur。
//  - 碰撞只做「粒子 vs 一个椭圆」，没有粒子间碰撞，复杂度 O(n)。
//
// 两条视觉规则值得单独说明：
//  1. 雨不会被头部「吃掉」。早期版本让雨撞到椭圆就消失，结果脸上出现一个
//     硬边的圆形空洞，非常假。现在雨只在头顶那段弧线上溅出水花，雨滴本身继续下落。
//  2. 烟花从画面底部升空、在高处炸开、粒子受重力下落——而不是从嘴里喷出来。
//     落到头上的粒子会分裂成更小的粒子向四周溅开。

import type { PersonCollider } from './segment'
import type { EffectConfig, Tier } from './config'

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
const RAIN_LAYER_WEIGHT = [0.5, 0.32, 0.18] // 远层最多，近层最少

const GRAVITY = 300 // px/s²（比真实重力慢，粒子才有时间飘落到人身上再碰撞）
const SPARK_DRAG = 0.985 // 每 1/60 秒
const MAX_SPLASH_PER_FRAME = 2
const FLASH_MS = 50
const PULSE_MS = 120
const PULSE_COOLDOWN_MS = 200
const MAX_ROCKETS = 8

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
  private rsplashed!: Uint8Array
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
  private kAlive = new Uint8Array(MAX_ROCKETS)
  private rocketAlive = 0

  // ---- 发光贴图 ----
  private glow: HTMLCanvasElement[] = []
  private glowSize = 64

  private palette = new Float32Array(PALETTE.length * 3)
  private rainColor = new Float32Array(3)
  private appliedHue = NaN

  private rainRate = 0
  private headPulse = 0
  private headPulseCooldown = 0
  private collisions = 0
  private splashesThisFrame = 0

  constructor(canvas: HTMLCanvasElement, cfg: EffectConfig, tier: Tier) {
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!ctx) throw new Error('Canvas 2D not available')
    this.ctx = ctx
    this.cfg = cfg
    this.tier = tier
    this.applyPalette()
    this.allocRain(tier.rainMax)
    this.allocSpark(tier.sparkPool)
    this.buildGlow()
  }

  // ---------- 生命周期 ----------

  private dpr = 1

  resize(w: number, h: number, dpr: number): void {
    this.w = w
    this.h = h
    this.dpr = dpr
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
    if (tier.rainMax > this.rainCap) this.allocRain(tier.rainMax)
    if (tier.sparkPool > this.sparkCap) this.allocSpark(tier.sparkPool)
  }

  get currentTier(): Tier {
    return this.tier
  }

  /** 人像遮挡开启时，雨画到人身后那层；关闭时画回同一张 canvas。 */
  setRainLayer(canvas: HTMLCanvasElement | null): void {
    this.rainCtx = canvas ? (canvas.getContext('2d') as CanvasRenderingContext2D) : null
    if (this.rainCtx) this.fit(this.rainCtx)
  }

  /** 退出回开始页时清空所有粒子。只清 alive 标志，不重新分配。 */
  clear(): void {
    this.rAlive.fill(0)
    this.sAlive.fill(0)
    this.kAlive.fill(0)
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
    this.rsplashed = new Uint8Array(cap)
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
    this.sAlive = new Uint8Array(cap)
    this.sparkAlive = 0
    this.sparkCursor = 0
  }

  private applyPalette(): void {
    if (this.appliedHue === this.cfg.hueShift) return
    this.appliedHue = this.cfg.hueShift
    for (let i = 0; i < PALETTE.length; i++) {
      rotateHue(PALETTE[i], this.cfg.hueShift, this.palette, i * 3)
    }
    rotateHue(RAIN_RGB, this.cfg.hueShift * 0.3, this.rainColor, 0)
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
  launch(power: number, scale = 1): void {
    let idx = -1
    for (let i = 0; i < MAX_ROCKETS; i++) {
      if (!this.kAlive[i]) {
        idx = i
        break
      }
    }
    if (idx < 0) return // 同屏烟花弹已满，直接丢弃

    const x = this.w * (0.12 + Math.random() * 0.76)
    const y0 = this.h + 12
    // 炸开高度落在画面上半部；scale 小的补发烟花炸得低一点、快一点
    const targetY = this.h * (0.12 + Math.random() * 0.26) * (scale < 0.6 ? 1.5 : 1)
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
  }

  /** 在指定位置直接炸开（升空到顶点后由 update 调用；也可单独用于调试） */
  burst(x: number, y: number, power: number, scale = 1): void {
    const base = Math.min(this.cfg.fireworkCount, this.tier.sparkPerBurst)
    const count = Math.max(12, Math.round(base * scale * (0.55 + 0.45 * power)))
    const speed = 200 + 230 * power
    const hue = (Math.random() * PALETTE.length) | 0
    for (let i = 0; i < count; i++) {
      const idx = this.acquireSpark()
      if (idx < 0) break
      const ang = Math.random() * Math.PI * 2
      const sp = speed * (0.35 + Math.random() * 0.65)
      this.sx[idx] = x
      this.sy[idx] = y
      this.spx[idx] = x
      this.spy[idx] = y
      this.svx[idx] = Math.cos(ang) * sp
      this.svy[idx] = Math.sin(ang) * sp
      const life = 1.15 + Math.random() * 1.05
      this.slife[idx] = life
      this.smax[idx] = life
      this.ssize[idx] = 5 + Math.random() * 7 * (0.6 + power * 0.4)
      // 一发烟花以一个主色为主，掺少量其它色，比纯随机好看
      this.scolor[idx] = Math.random() < 0.75 ? hue : (Math.random() * PALETTE.length) | 0
      this.sflash[idx] = 0
      this.sgen[idx] = 0
    }
  }

  /** 烟花粒子撞到头：分裂成更小的粒子向四周溅开 */
  private shatter(i: number, nx: number, ny: number): void {
    const parentColor = this.scolor[i]
    const parentSize = this.ssize[i]
    const speed = Math.hypot(this.svx[i], this.svy[i])
    const n = 3 + ((Math.random() * 3) | 0)
    for (let k = 0; k < n; k++) {
      const idx = this.acquireSpark()
      if (idx < 0) break
      // 以碰撞法线为中心，向四周散开
      const ang = Math.atan2(ny, nx) + (Math.random() - 0.5) * 2.4
      const sp = (60 + speed * 0.35) * (0.5 + Math.random() * 0.8)
      this.sx[idx] = this.sx[i]
      this.sy[idx] = this.sy[i]
      this.spx[idx] = this.sx[i]
      this.spy[idx] = this.sy[i]
      this.svx[idx] = Math.cos(ang) * sp
      this.svy[idx] = Math.sin(ang) * sp
      const life = 0.3 + Math.random() * 0.35
      this.slife[idx] = life
      this.smax[idx] = life
      this.ssize[idx] = parentSize * (0.35 + Math.random() * 0.2)
      this.scolor[idx] = Math.random() < 0.5 ? parentColor : 2 // 掺一点奶白当火星
      this.sflash[idx] = FLASH_MS
      this.sgen[idx] = 1 // 碎片不再分裂，避免连锁
    }
  }

  /** 雨滴打在头顶的小水花（雨滴本身不消失，避免脸上出现空洞） */
  private splash(x: number, y: number, nx: number, ny: number): void {
    if (this.splashesThisFrame >= MAX_SPLASH_PER_FRAME) return
    this.splashesThisFrame++
    const n = 2 + ((Math.random() * 2) | 0)
    for (let i = 0; i < n; i++) {
      const idx = this.acquireSpark()
      if (idx < 0) return
      const spread = (Math.random() - 0.5) * 1.6
      const sp = 60 + Math.random() * 80
      this.sx[idx] = x
      this.sy[idx] = y
      this.spx[idx] = x
      this.spy[idx] = y
      this.svx[idx] = (nx + spread) * sp
      this.svy[idx] = (ny - 0.4) * sp
      const life = 0.2 + Math.random() * 0.16
      this.slife[idx] = life
      this.smax[idx] = life
      this.ssize[idx] = 2.2 + Math.random() * 1.8
      this.scolor[idx] = 2
      this.sflash[idx] = 0
      this.sgen[idx] = 1
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
    const sp = RAIN_SPEED[layer] * (0.9 + Math.random() * 0.2)
    this.rvy[idx] = sp
    this.rvx[idx] = RAIN_DRIFT[layer] * (0.8 + Math.random() * 0.4)
    this.rlen[idx] = sp * RAIN_STREAK
    this.rsplashed[idx] = 0
  }

  // ---------- 更新 ----------

  update(dt: number, head: HeadEllipse | null, person: PersonCollider | null = null): void {
    this.splashesThisFrame = 0
    this.collisions = 0
    const dtMs = dt * 1000

    if (this.headPulse > 0) this.headPulse -= dtMs
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
      this.kvy[i] += this.kay[i] * dt
      this.kx[i] += this.kvx[i] * dt
      this.ky[i] += this.kvy[i] * dt
      // 到达顶点（或飞出画面顶部）就炸开
      if (this.kvy[i] >= 0 || this.ky[i] < 8) {
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

    // --- 雨：积分 + 头顶溅射（不吃掉雨滴）---
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
      // 人像遮罩：雨滴从「不是人」进入「是人」的那一格就是轮廓上沿——头顶、肩膀、举起的手。
      // 溅一次水花后雨滴继续走，视觉上被人像层挡住（雨在人身后），不会有空洞。
      if (person && this.rlayer[i] >= 1 && !this.rsplashed[i] && person.isPerson(this.rx[i], this.ry[i])) {
        this.rsplashed[i] = 1
        person.normal(this.rx[i], this.ry[i], this.nrm)
        if (this.nrm[1] < -0.2) this.splash(this.rx[i], this.ry[i], this.nrm[0], this.nrm[1])
        continue
      }
      // 只有近处两层、且还没溅过的雨滴，在头顶那段弧线上溅一次水花。
      // 雨滴继续往下走——早期版本让它消失，脸上会出现一个硬边圆形空洞。
      if (!person && hasHead && this.rlayer[i] >= 1 && !this.rsplashed[i]) {
        const dx = this.rx[i] - cx
        const dy = this.ry[i] - cy
        const lx = dx * cosR + dy * sinR
        const ly = -dx * sinR + dy * cosR
        const u = lx / rx
        const v = ly / ry
        if (u * u + v * v < 1) {
          this.rsplashed[i] = 1
          // 「上半弧」是相对头部的上方，不是屏幕的上方——歪头时也要打在头顶
          if (v < -0.25) {
            let lnx = u / rx
            let lny = v / ry
            const nl = Math.hypot(lnx, lny) || 1
            lnx /= nl
            lny /= nl
            this.splash(this.rx[i], this.ry[i], lnx * cosR - lny * sinR, lnx * sinR + lny * cosR)
          }
        }
      }
    }

    // --- 火花：积分 + 碰撞 ---
    const drag = Math.pow(SPARK_DRAG, dt * 60)
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

      this.svy[i] += GRAVITY * dt
      this.svx[i] *= drag
      this.svy[i] *= drag
      this.sx[i] += this.svx[i] * dt
      this.sy[i] += this.svy[i] * dt

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
    if (this.sgen[i] === 0) {
      this.shatter(i, nx, ny)
      this.sAlive[i] = 0
      this.sparkAlive--
    } else {
      const vn = this.svx[i] * nx + this.svy[i] * ny
      if (vn < 0) {
        this.svx[i] -= (1 + rest) * vn * nx
        this.svy[i] -= (1 + rest) * vn * ny
        this.svx[i] *= 0.8
        this.svy[i] *= 0.8
      }
      this.sflash[i] = FLASH_MS
    }
  }

  // ---------- 绘制 ----------

  draw(head: HeadEllipse | null): void {
    this.ctx.clearRect(0, 0, this.w, this.h)
    if (this.rainCtx) this.rainCtx.clearRect(0, 0, this.w, this.h)
    // 雨画到人身后那层（若开启），其余都在最前面那层
    const rctx = this.rainCtx ?? this.ctx
    this.drawRain(rctx)
    this.drawFront(head)
  }

  private drawRain(ctx: CanvasRenderingContext2D): void {
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineCap = 'round'
    const rc = `${this.rainColor[0] | 0},${this.rainColor[1] | 0},${this.rainColor[2] | 0}`
    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath()
      ctx.strokeStyle = `rgba(${rc},${RAIN_ALPHA[layer]})`
      ctx.lineWidth = RAIN_WIDTH[layer]
      let any = false
      const tail = RAIN_DRIFT[layer] * RAIN_STREAK
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

  private drawFront(head: HeadEllipse | null): void {
    const ctx = this.ctx
    // 头部微光脉冲：碰撞发生时沿椭圆边缘亮一圈
    if (head && this.headPulse > 0) {
      const t = this.headPulse / PULSE_MS
      ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      ctx.ellipse(head.cx, head.cy, head.rx, head.ry, head.rot, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,238,214,${0.32 * t})`
      ctx.lineWidth = 2 + 7 * (1 - t)
      ctx.stroke()
    }

    ctx.globalCompositeOperation = 'lighter'
    const glow = this.glow
    const whiteIdx = glow.length - 1

    // 升空中的烟花弹：一个亮点 + 一条尾焰
    for (let i = 0; i < MAX_ROCKETS; i++) {
      if (!this.kAlive[i]) continue
      const c = this.kcolor[i] * 3
      ctx.globalAlpha = 0.9
      ctx.drawImage(glow[this.kcolor[i]], this.kx[i] - 11, this.ky[i] - 11, 22, 22)
      ctx.globalAlpha = 0.45
      ctx.beginPath()
      ctx.strokeStyle = `rgb(${this.palette[c] | 0},${this.palette[c + 1] | 0},${this.palette[c + 2] | 0})`
      ctx.lineWidth = 2
      ctx.moveTo(this.kx[i], this.ky[i])
      ctx.lineTo(this.kx[i] - this.kvx[i] * 0.05, this.ky[i] - this.kvy[i] * 0.05)
      ctx.stroke()
    }

    // 火花
    for (let i = 0; i < this.sparkCap; i++) {
      if (!this.sAlive[i]) continue
      const t = this.slife[i] / this.smax[i]
      const alpha = t * Math.sqrt(t) // 比 t² 衰减慢，火花亮得久一点
      const size = this.ssize[i] * (0.5 + 0.5 * t) * 3.2
      const half = size / 2
      const img = this.sflash[i] > 0 ? glow[whiteIdx] : glow[this.scolor[i]]
      ctx.globalAlpha = alpha
      ctx.drawImage(img, this.sx[i] - half, this.sy[i] - half, size, size)
      const dx = this.sx[i] - this.spx[i]
      const dy = this.sy[i] - this.spy[i]
      if (dx * dx + dy * dy > 4) {
        const c = this.scolor[i] * 3
        ctx.globalAlpha = alpha * 0.5
        ctx.beginPath()
        ctx.strokeStyle = `rgb(${this.palette[c] | 0},${this.palette[c + 1] | 0},${this.palette[c + 2] | 0})`
        ctx.lineWidth = Math.max(1, this.ssize[i] * 0.35 * t)
        ctx.moveTo(this.spx[i] - dx * 1.5, this.spy[i] - dy * 1.5)
        ctx.lineTo(this.sx[i], this.sy[i])
        ctx.stroke()
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
