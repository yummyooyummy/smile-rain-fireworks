// 粒子引擎：雨 + 烟花 + 头部椭圆碰撞。
//
// 性能约定（对应 CLAUDE.md）：
//  - 所有粒子数据放在预分配的 Float32Array（SoA）里，update/draw 循环内零分配。
//  - 发光用预渲染的径向渐变贴图 drawImage + 'lighter'，绝不用 shadowBlur。
//  - 碰撞只做「粒子 vs 一个椭圆」，没有粒子间碰撞，复杂度 O(n)。

import type { EffectConfig, Tier } from './config'

export interface HeadEllipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

/** 烟花调色板（暗调暖色，4 色，见设计定义 §4） */
const PALETTE: [number, number, number][] = [
  [240, 120, 90], // 珊瑚橙 #F0785A
  [233, 185, 90], // 暖金   #E9B95A
  [255, 243, 224], // 奶白   #FFF3E0
  [111, 195, 184], // 一点青 #6FC3B8
]
const RAIN_RGB: [number, number, number] = [191, 212, 242] // #BFD4F2

const RAIN_LAYER_SPEED = [300, 480, 720] // px/s
const RAIN_LAYER_ALPHA = [0.25, 0.45, 0.7]
const RAIN_LAYER_WIDTH = [1, 1.4, 1.9]

const GRAVITY = 380 // px/s²
const SPARK_DRAG = 0.985 // 每 1/60 秒
const MAX_SPLASH_PER_FRAME = 2
const FLASH_MS = 50
const PULSE_MS = 100
const PULSE_COOLDOWN_MS = 200

/** 把 [r,g,b] 按色相偏移旋转，返回 CSS 颜色的三个分量 */
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
  // YIQ 近似色相旋转矩阵，够快也够准
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

export interface EffectStats {
  rainAlive: number
  sparkAlive: number
  collisions: number
}

export class Effects {
  private ctx: CanvasRenderingContext2D
  private w = 0
  private h = 0

  private cfg: EffectConfig
  private tier: Tier

  // ---- 雨池（SoA）----
  private rx!: Float32Array
  private ry!: Float32Array
  private rvy!: Float32Array
  private rlen!: Float32Array
  private rlayer!: Uint8Array
  private rAlive!: Uint8Array
  private rainCap = 0
  private rainCursor = 0
  private rainAlive = 0
  private rainBudget = 0 // 累积的生成配额（小数）

  // ---- 火花池（SoA）----
  private sx!: Float32Array
  private sy!: Float32Array
  private spx!: Float32Array // 上一帧位置，用于画拖尾
  private spy!: Float32Array
  private svx!: Float32Array
  private svy!: Float32Array
  private slife!: Float32Array
  private smax!: Float32Array
  private ssize!: Float32Array
  private scolor!: Uint8Array
  private sflash!: Float32Array // 碰撞闪白剩余毫秒
  private sAlive!: Uint8Array
  private sparkCap = 0
  private sparkCursor = 0
  private sparkAlive = 0

  // ---- 发光贴图 ----
  private glow: HTMLCanvasElement[] = []
  private glowSize = 64

  // ---- 调色板（应用色相偏移后的实际颜色）----
  private palette = new Float32Array(PALETTE.length * 3)
  private rainColor = new Float32Array(3)
  private appliedHue = NaN

  // ---- 运行时 ----
  private rainRate = 0 // 0–1
  private headPulse = 0 // 剩余毫秒
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

  resize(w: number, h: number, dpr: number): void {
    this.w = w
    this.h = h
    const c = this.ctx.canvas
    c.width = Math.round(w * dpr)
    c.height = Math.round(h * dpr)
    c.style.width = `${w}px`
    c.style.height = `${h}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  setConfig(cfg: EffectConfig): void {
    this.cfg = cfg
    this.applyPalette()
  }

  setTier(tier: Tier): void {
    if (tier.name === this.tier.name) return
    this.tier = tier
    // 只在变大时重新分配，变小时保留数组、压低使用上限，避免运行中反复 GC
    if (tier.rainMax > this.rainCap) this.allocRain(tier.rainMax)
    if (tier.sparkPool > this.sparkCap) this.allocSpark(tier.sparkPool)
  }

  get currentTier(): Tier {
    return this.tier
  }

  /** 微笑强度映射后的雨量，0–1 */
  setRainRate(rate: number): void {
    this.rainRate = rate < 0 ? 0 : rate > 1 ? 1 : rate
  }

  get stats(): EffectStats {
    return { rainAlive: this.rainAlive, sparkAlive: this.sparkAlive, collisions: this.collisions }
  }

  // ---------- 分配 ----------

  private allocRain(cap: number): void {
    this.rainCap = cap
    this.rx = new Float32Array(cap)
    this.ry = new Float32Array(cap)
    this.rvy = new Float32Array(cap)
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

  /** 每种颜色预渲染一张径向渐变贴图，draw 时只 drawImage */
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
    // 额外一张纯白，用于碰撞闪白
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

  /** 从 (x,y) 炸开一发烟花。power 0–1 控制爆炸半径与粒子数。 */
  burst(x: number, y: number, power: number, scale = 1): void {
    const base = Math.min(this.cfg.fireworkCount, this.tier.sparkPerBurst)
    const count = Math.max(12, Math.round(base * scale * (0.55 + 0.45 * power)))
    const speed = 190 + 210 * power
    for (let i = 0; i < count; i++) {
      const idx = this.acquireSpark()
      if (idx < 0) break
      // 均匀方向 + 轻微向上偏置，让烟花看起来是「炸开」而不是「散落」
      const ang = Math.random() * Math.PI * 2
      const sp = speed * (0.35 + Math.random() * 0.65)
      this.sx[idx] = x
      this.sy[idx] = y
      this.spx[idx] = x
      this.spy[idx] = y
      this.svx[idx] = Math.cos(ang) * sp
      this.svy[idx] = Math.sin(ang) * sp - 40
      const life = 0.75 + Math.random() * 0.8
      this.slife[idx] = life
      this.smax[idx] = life
      this.ssize[idx] = 5 + Math.random() * 7 * (0.6 + power * 0.4)
      this.scolor[idx] = (Math.random() * PALETTE.length) | 0
      this.sflash[idx] = 0
    }
  }

  /** 雨滴撞头时的小水花 */
  private splash(x: number, y: number, nx: number, ny: number): void {
    if (this.splashesThisFrame >= MAX_SPLASH_PER_FRAME) return
    this.splashesThisFrame++
    const n = 2 + ((Math.random() * 2) | 0)
    for (let i = 0; i < n; i++) {
      const idx = this.acquireSpark()
      if (idx < 0) return
      const spread = (Math.random() - 0.5) * 1.6
      const sp = 70 + Math.random() * 90
      this.sx[idx] = x
      this.sy[idx] = y
      this.spx[idx] = x
      this.spy[idx] = y
      this.svx[idx] = (nx + spread) * sp
      this.svy[idx] = (ny - 0.5) * sp
      const life = 0.22 + Math.random() * 0.18
      this.slife[idx] = life
      this.smax[idx] = life
      this.ssize[idx] = 2.5 + Math.random() * 2
      this.scolor[idx] = 2 // 奶白，接近水色
      this.sflash[idx] = 0
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
    return -1 // 池满，直接丢弃，绝不扩容
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
    const layer = (Math.random() * 3) | 0
    this.rlayer[idx] = layer
    this.rx[idx] = Math.random() * (this.w + 120) - 60
    this.ry[idx] = -20 - Math.random() * 120
    const sp = RAIN_LAYER_SPEED[layer] * (0.9 + Math.random() * 0.2)
    this.rvy[idx] = sp
    this.rlen[idx] = sp * 0.028
  }

  // ---------- 更新 ----------

  update(dt: number, head: HeadEllipse | null): void {
    this.splashesThisFrame = 0
    this.collisions = 0
    const dtMs = dt * 1000

    if (this.headPulse > 0) this.headPulse -= dtMs
    if (this.headPulseCooldown > 0) this.headPulseCooldown -= dtMs

    // --- 雨：按 rainRate 生成 ---
    const targetRate = this.rainRate * this.tier.rainMax * this.cfg.rainMax * 1.6 // 每秒生成数
    this.rainBudget += targetRate * dt
    if (this.rainBudget > 60) this.rainBudget = 60 // 配额封顶，避免掉帧后一次性喷一大坨
    while (this.rainBudget >= 1) {
      this.rainBudget -= 1
      this.spawnRain()
    }

    const hasHead = head !== null
    const cx = hasHead ? head!.cx : 0
    const cy = hasHead ? head!.cy : 0
    const rx = hasHead ? head!.rx : 1
    const ry = hasHead ? head!.ry : 1
    const bottom = this.h + 40

    // --- 雨：积分 + 碰撞 ---
    const rainCap = this.rainCap
    for (let i = 0; i < rainCap; i++) {
      if (!this.rAlive[i]) continue
      this.ry[i] += this.rvy[i] * dt
      if (this.ry[i] > bottom) {
        this.rAlive[i] = 0
        this.rainAlive--
        continue
      }
      if (hasHead && this.rlayer[i] >= 1) {
        const u = (this.rx[i] - cx) / rx
        const v = (this.ry[i] - cy) / ry
        if (u * u + v * v < 1) {
          // 撞到头：溅开并消失
          let nx = u / rx
          let ny = v / ry
          const nl = Math.hypot(nx, ny) || 1
          nx /= nl
          ny /= nl
          this.splash(this.rx[i], this.ry[i], nx, ny)
          this.rAlive[i] = 0
          this.rainAlive--
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

      if (!hasHead) continue
      const u = (this.sx[i] - cx) / rx
      const v = (this.sy[i] - cy) / ry
      const d2 = u * u + v * v
      if (d2 >= 1 || d2 === 0) continue

      // 在椭圆内 → 推回边界 + 沿法线反弹
      const s = 1 / Math.sqrt(d2)
      this.sx[i] = cx + u * s * rx
      this.sy[i] = cy + v * s * ry
      let nx = u / rx
      let ny = v / ry
      const nl = Math.hypot(nx, ny) || 1
      nx /= nl
      ny /= nl
      const vn = this.svx[i] * nx + this.svy[i] * ny
      if (vn < 0) {
        this.svx[i] -= (1 + rest) * vn * nx
        this.svy[i] -= (1 + rest) * vn * ny
        this.svx[i] *= 0.85
        this.svy[i] *= 0.85
      }
      this.sflash[i] = FLASH_MS
      this.collisions++
      if (this.headPulseCooldown <= 0) {
        this.headPulse = PULSE_MS
        this.headPulseCooldown = PULSE_COOLDOWN_MS
      }
    }
  }

  // ---------- 绘制 ----------

  draw(head: HeadEllipse | null): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.w, this.h)

    // 雨：普通混合的细线，压在下面
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineCap = 'round'
    const rc = `${this.rainColor[0] | 0},${this.rainColor[1] | 0},${this.rainColor[2] | 0}`
    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath()
      ctx.strokeStyle = `rgba(${rc},${RAIN_LAYER_ALPHA[layer]})`
      ctx.lineWidth = RAIN_LAYER_WIDTH[layer]
      let any = false
      for (let i = 0; i < this.rainCap; i++) {
        if (!this.rAlive[i] || this.rlayer[i] !== layer) continue
        const x = this.rx[i]
        const y = this.ry[i]
        ctx.moveTo(x, y)
        ctx.lineTo(x + 1.5, y + this.rlen[i])
        any = true
      }
      if (any) ctx.stroke()
    }

    // 头部微光脉冲：碰撞发生时沿椭圆边缘亮一圈
    if (head && this.headPulse > 0) {
      const t = this.headPulse / PULSE_MS
      ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      ctx.ellipse(head.cx, head.cy, head.rx, head.ry, 0, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,238,214,${0.35 * t})`
      ctx.lineWidth = 2 + 6 * (1 - t)
      ctx.stroke()
    }

    // 火花：加色混合的发光贴图 + 拖尾
    ctx.globalCompositeOperation = 'lighter'
    const glow = this.glow
    const whiteIdx = glow.length - 1
    for (let i = 0; i < this.sparkCap; i++) {
      if (!this.sAlive[i]) continue
      const t = this.slife[i] / this.smax[i] // 1 → 0
      const alpha = t * t
      const size = this.ssize[i] * (0.5 + 0.5 * t) * 3.2
      const half = size / 2
      const img = this.sflash[i] > 0 ? glow[whiteIdx] : glow[this.scolor[i]]
      ctx.globalAlpha = alpha
      ctx.drawImage(img, this.sx[i] - half, this.sy[i] - half, size, size)
      // 拖尾：从上一帧位置到当前位置的一小段
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
    ctx.ellipse(head.cx, head.cy, head.rx, head.ry, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}
