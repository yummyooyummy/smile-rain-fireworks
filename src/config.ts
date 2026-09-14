// 特效配置：所有可调参数集中在此。
// 高级模式抽屉直接改这个对象，URL ?cfg=<base64> 可覆盖，导出即 effect.json。

export interface EffectConfig {
  /** 进入 Smiling 的微笑阈值 */
  smileEnter: number
  /** 进入 Laughing 的张嘴阈值 */
  laughJaw: number
  /** 雨量上限倍率 0–1，最终雨滴数还要乘档位上限 */
  rainMax: number
  /** 单发烟花粒子数基准（实际会按 jawOpen 与档位缩放） */
  fireworkCount: number
  /** 碰撞弹性 */
  restitution: number
  /** 烟花炸开范围倍率（1 = 基准） */
  burstScale: number
  /** 调色板色相偏移（度） */
  hueShift: number
  /** 画出当前碰撞体（椭圆或人像遮罩） */
  showCollider: boolean
  /** 人像分割：遮挡 + 像素级碰撞（低档机自动关） */
  personSeg: boolean
  /** 是否显示引导提示与进度条 */
  showGuide: boolean
  /** 是否显示调试数据 */
  showDebug: boolean
}

export const DEFAULT_CONFIG: EffectConfig = {
  // 真机实测手感（Yuqing，2026-09-13）。退出阈值不再单独存：见 state.ts 的 EXIT_RATIO
  smileEnter: 0.3,
  laughJaw: 0.15,
  rainMax: 1,
  fireworkCount: 600,
  restitution: 0.8,
  burstScale: 1.75,
  hueShift: 0,
  showCollider: false,
  personSeg: true,
  showGuide: true,
  showDebug: false,
}

/** 滑块元数据，抽屉 UI 直接读它生成控件 */
/**
 * 玩家看到的是词，不是数。每条控件用「左端 / 中点 / 右端」三个底层值描述，
 * 滑杆是 0–100 的位置，中点 50 恒等于默认值——所以打开面板时每个圆点都在正中间。
 * 灵敏度两条的 left > right（阈值越低越灵敏），这样「往右 = 更容易触发」符合直觉。
 * 真实数值只在调试模式下显示。
 */
export const CONTROLS = [
  { key: 'smileEnter', left: 0.5, mid: 0.3, right: 0.15, step: 0.01 },
  { key: 'laughJaw', left: 0.3, mid: 0.15, right: 0.08, step: 0.01 },
  { key: 'rainMax', left: 0.4, mid: 1, right: 1.6, step: 0.05 },
  { key: 'burstScale', left: 1, mid: 1.75, right: 2.5, step: 0.05 },
  { key: 'fireworkCount', left: 300, mid: 600, right: 900, step: 10 },
  { key: 'restitution', left: 0.6, mid: 0.8, right: 1, step: 0.05 },
] as const

export type SliderKey = (typeof CONTROLS)[number]['key']
export type ControlMeta = (typeof CONTROLS)[number]

/** 滑杆位置（0–100）→ 底层值，两段各自线性 */
export function posToValue(m: ControlMeta, pos: number): number {
  const t = Math.max(0, Math.min(100, pos))
  const v = t <= 50 ? m.left + ((m.mid - m.left) * t) / 50 : m.mid + ((m.right - m.mid) * (t - 50)) / 50
  return Math.round(v / m.step) * m.step
}

/** 底层值 → 滑杆位置，posToValue 的反函数（两段都是单调的，分段求解） */
export function valueToPos(m: ControlMeta, v: number): number {
  const lo = Math.min(m.left, m.mid)
  const hi = Math.max(m.left, m.mid)
  if (v >= lo && v <= hi && m.mid !== m.left) return ((v - m.left) / (m.mid - m.left)) * 50
  if (m.right !== m.mid) return 50 + ((v - m.mid) / (m.right - m.mid)) * 50
  return 50
}

/** 烟花配色预设：底层就是调色板整体的色相偏移角 */
export const PALETTE_PRESETS = [
  { id: 'warm', hue: 0, swatch: ['#F0785A', '#E9B95A', '#FFF3E0'] },
  { id: 'sakura', hue: -28, swatch: ['#F07A8E', '#F0A8C0', '#FFF0F3'] },
  { id: 'mint', hue: 60, swatch: ['#6FC3B8', '#A8E0A0', '#EAFBF2'] },
] as const

export type PalettePresetId = (typeof PALETTE_PRESETS)[number]['id']

// ---------- 性能档位 ----------

export interface Tier {
  name: 'low' | 'mid' | 'high'
  rainMax: number
  sparkPerBurst: number
  sparkPool: number
}

export const TIERS: Record<Tier['name'], Tier> = {
  low: { name: 'low', rainMax: 250, sparkPerBurst: 140, sparkPool: 900 },
  mid: { name: 'mid', rainMax: 500, sparkPerBurst: 280, sparkPool: 2000 },
  high: { name: 'high', rainMax: 800, sparkPerBurst: 460, sparkPool: 3200 },
}

// ---------- URL 参数 ----------

export interface RuntimeFlags {
  debug: boolean
  pro: boolean
  clean: boolean
  /** ?seg=0 关掉人像分割（对比性能用） */
  seg: boolean
  /** ?tier=low|mid|high 钉住档位，不自适应（对比性能用） */
  tier: 'low' | 'mid' | 'high' | null
}

export function readFlags(search = location.search): RuntimeFlags {
  const p = new URLSearchParams(search)
  const mode = p.get('mode')
  return {
    debug: p.get('debug') === '1',
    pro: mode === 'pro',
    clean: mode === 'clean',
    seg: p.get('seg') !== '0',
    tier: (['low', 'mid', 'high'] as const).find((t) => t === p.get('tier')) ?? null,
  }
}

const CFG_NUM_KEYS = [
  'smileEnter',
  'laughJaw',
  'rainMax',
  'fireworkCount',
  'restitution',
  'burstScale',
  'hueShift',
] as const

/** 从 URL ?cfg= 读配置覆盖；解析失败静默忽略，绝不让 demo 白屏 */
export function readConfigOverride(search = location.search): Partial<EffectConfig> {
  const raw = new URLSearchParams(search).get('cfg')
  if (!raw) return {}
  try {
    const json = decodeURIComponent(escape(atob(raw)))
    const parsed = JSON.parse(json) as Partial<EffectConfig>
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<EffectConfig> = { ...parsed }
    for (const k of CFG_NUM_KEYS) {
      const v = out[k]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) delete out[k]
    }
    return out
  } catch {
    return {}
  }
}
