// 特效配置：所有可调参数集中在此。
// 高级模式抽屉直接改这个对象，URL ?cfg=<base64> 可覆盖，导出即 effect.json。

export interface EffectConfig {
  /** 进入 Smiling 的微笑阈值 */
  smileEnter: number
  /** 退出 Smiling 的微笑阈值（必须低于 smileEnter，构成迟滞） */
  smileExit: number
  /** 进入 Laughing 的微笑阈值 */
  laughSmile: number
  /** 进入 Laughing 的张嘴阈值 */
  laughJaw: number
  /** 退出 Laughing 的张嘴阈值 */
  laughExitJaw: number
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
  smileEnter: 0.45,
  smileExit: 0.3,
  laughSmile: 0.6,
  laughJaw: 0.35,
  laughExitJaw: 0.2,
  rainMax: 1,
  fireworkCount: 180,
  restitution: 0.65,
  burstScale: 1.25,
  hueShift: 0,
  showCollider: false,
  personSeg: true,
  showGuide: true,
  showDebug: false,
}

/** 滑块元数据，抽屉 UI 直接读它生成控件 */
export const SLIDERS = [
  { key: 'smileEnter', min: 0.3, max: 0.7, step: 0.01 },
  { key: 'laughJaw', min: 0.15, max: 0.8, step: 0.01 },
  { key: 'rainMax', min: 0, max: 1, step: 0.05 },
  { key: 'fireworkCount', min: 60, max: 400, step: 10 },
  { key: 'burstScale', min: 0.6, max: 2, step: 0.05 },
  { key: 'restitution', min: 0.3, max: 0.9, step: 0.05 },
  { key: 'hueShift', min: -30, max: 30, step: 1 },
] as const

export type SliderKey = (typeof SLIDERS)[number]['key']

// ---------- 性能档位 ----------

export interface Tier {
  name: 'low' | 'mid' | 'high'
  rainMax: number
  sparkPerBurst: number
  sparkPool: number
}

export const TIERS: Record<Tier['name'], Tier> = {
  low: { name: 'low', rainMax: 250, sparkPerBurst: 100, sparkPool: 700 },
  mid: { name: 'mid', rainMax: 500, sparkPerBurst: 180, sparkPool: 1400 },
  high: { name: 'high', rainMax: 800, sparkPerBurst: 300, sparkPool: 2200 },
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

/** 从 URL ?cfg= 读配置覆盖；解析失败静默忽略，绝不让 demo 白屏 */
export function readConfigOverride(search = location.search): Partial<EffectConfig> {
  const raw = new URLSearchParams(search).get('cfg')
  if (!raw) return {}
  try {
    const json = decodeURIComponent(escape(atob(raw)))
    const parsed = JSON.parse(json) as Partial<EffectConfig>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function loadConfig(): Promise<EffectConfig> {
  let base: EffectConfig = { ...DEFAULT_CONFIG }
  try {
    const res = await fetch('effect.json', { cache: 'no-cache' })
    if (res.ok) base = { ...base, ...(await res.json()) }
  } catch {
    /* 用默认值 */
  }
  return { ...base, ...readConfigOverride() }
}
