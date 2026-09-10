// 高级模式抽屉（L3）。只通过预留接口读写配置，不碰引擎内部：
//   window 'open-drawer' 打开；window.__fx = { getConfig, setConfig, getTier }
// 文案全部来自 copy.ts；桌面右侧滑入 ≤320px，手机底部滑入 ≤60vh，无全屏遮罩。

import { SLIDERS, readFlags, type EffectConfig, type SliderKey } from './config'
import { copy } from './copy'

interface FxBridge {
  getConfig: () => EffectConfig
  setConfig: (next: EffectConfig) => void
  getTier: () => 'low' | 'mid' | 'high'
}

function sliderLabel(key: SliderKey): string {
  switch (key) {
    case 'smileEnter':
      return copy.drawer.smileThreshold
    case 'laughJaw':
      return copy.drawer.laughThreshold
    case 'rainMax':
      return copy.drawer.rainMax
    case 'fireworkCount':
      return copy.drawer.fireworkCount
    case 'restitution':
      return copy.drawer.restitution
    case 'hueShift':
      return copy.drawer.hueShift
  }
}

function getFx(): FxBridge | undefined {
  return (window as unknown as { __fx?: FxBridge }).__fx
}

function parseSlider(key: SliderKey, raw: string): number {
  const meta = SLIDERS.find((s) => s.key === key)
  if (!meta) return Number(raw)
  return meta.step >= 1 ? Number.parseInt(raw, 10) : Number.parseFloat(raw)
}

function formatSlider(key: SliderKey, n: number): string {
  const meta = SLIDERS.find((s) => s.key === key)
  if (!meta || meta.step >= 1) return String(Math.round(n))
  return n.toFixed(2)
}

const panel = document.createElement('aside')
panel.className = 'drawer'
panel.setAttribute('aria-hidden', 'true')

const sliderMarkup = SLIDERS.map(
  (s) => `
    <label class="drawer-field">
      <span class="drawer-field-head">
        <span>${sliderLabel(s.key)}</span>
        <span class="drawer-val" data-val="${s.key}"></span>
      </span>
      <input type="range" data-slider="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
    </label>`,
).join('')

panel.innerHTML = `
  <div class="drawer-sheet">
    <header class="drawer-head">
      <h2 class="drawer-title">${copy.drawer.title}</h2>
      <button type="button" class="drawer-close" id="drawerClose" aria-label="${copy.drawer.title}">×</button>
    </header>
    <div class="drawer-body">
      ${sliderMarkup}
      <label class="drawer-switch">
        <input type="checkbox" data-toggle="showGuide" />
        <span>${copy.drawer.showGuide}</span>
      </label>
      <label class="drawer-switch">
        <input type="checkbox" data-toggle="showDebug" />
        <span>${copy.drawer.showDebug}</span>
      </label>
      <button type="button" class="btn-ghost drawer-export" id="drawerExport">${copy.drawer.exportJson}</button>
      <p class="drawer-feedback" id="drawerFeedback" hidden></p>
      <p class="drawer-tier">${copy.drawer.tier} <span id="drawerTier"></span></p>
    </div>
  </div>
`

document.body.appendChild(panel)

const closeBtn = panel.querySelector('#drawerClose') as HTMLButtonElement
const exportBtn = panel.querySelector('#drawerExport') as HTMLButtonElement
const feedback = panel.querySelector('#drawerFeedback') as HTMLElement
const tierEl = panel.querySelector('#drawerTier') as HTMLElement

let open = false
let tierTimer = 0
let feedbackTimer = 0

function syncFromConfig(): void {
  const fx = getFx()
  if (!fx) return
  const cfg = fx.getConfig()
  for (const s of SLIDERS) {
    const input = panel.querySelector<HTMLInputElement>(`[data-slider="${s.key}"]`)
    const val = panel.querySelector<HTMLElement>(`[data-val="${s.key}"]`)
    if (!input || !val) continue
    const n = cfg[s.key]
    input.value = String(n)
    val.textContent = formatSlider(s.key, n)
  }
  const guide = panel.querySelector<HTMLInputElement>('[data-toggle="showGuide"]')
  const debug = panel.querySelector<HTMLInputElement>('[data-toggle="showDebug"]')
  if (guide) guide.checked = cfg.showGuide
  if (debug) debug.checked = cfg.showDebug
  tierEl.textContent = fx.getTier()
}

function setOpen(next: boolean): void {
  if (open === next) {
    if (next) syncFromConfig()
    return
  }
  open = next
  panel.classList.toggle('is-open', next)
  panel.setAttribute('aria-hidden', next ? 'false' : 'true')
  if (next) {
    syncFromConfig()
    if (tierTimer) window.clearInterval(tierTimer)
    tierTimer = window.setInterval(() => {
      const fx = getFx()
      if (fx) tierEl.textContent = fx.getTier()
    }, 500)
  } else if (tierTimer) {
    window.clearInterval(tierTimer)
    tierTimer = 0
  }
}

function patchConfig(partial: Partial<EffectConfig>): void {
  const fx = getFx()
  if (!fx) return
  fx.setConfig({ ...fx.getConfig(), ...partial })
  const cfg = fx.getConfig()
  for (const s of SLIDERS) {
    const val = panel.querySelector<HTMLElement>(`[data-val="${s.key}"]`)
    if (val) val.textContent = formatSlider(s.key, cfg[s.key])
  }
  tierEl.textContent = fx.getTier()
}

panel.addEventListener('input', (e) => {
  const t = e.target
  if (!(t instanceof HTMLInputElement)) return
  const slider = t.dataset.slider as SliderKey | undefined
  if (slider) {
    patchConfig({ [slider]: parseSlider(slider, t.value) })
    return
  }
  const toggle = t.dataset.toggle
  if (toggle === 'showGuide') patchConfig({ showGuide: t.checked })
  if (toggle === 'showDebug') patchConfig({ showDebug: t.checked })
})

async function exportConfig(): Promise<void> {
  const fx = getFx()
  if (!fx) return
  const json = JSON.stringify(fx.getConfig(), null, 2)
  try {
    await navigator.clipboard.writeText(json)
  } catch {
    /* 下载仍然进行 */
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'effect.json'
  a.click()
  URL.revokeObjectURL(url)
  feedback.hidden = false
  feedback.textContent = copy.drawer.exported
  if (feedbackTimer) window.clearTimeout(feedbackTimer)
  feedbackTimer = window.setTimeout(() => {
    feedback.hidden = true
  }, 2000)
}

closeBtn.addEventListener('click', () => setOpen(false))
exportBtn.addEventListener('click', () => void exportConfig())

window.addEventListener('open-drawer', () => setOpen(!open))

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && open) setOpen(false)
})

function openWhenReady(frames = 0): void {
  if (getFx()) {
    setOpen(true)
    return
  }
  if (frames < 60) requestAnimationFrame(() => openWhenReady(frames + 1))
}

if (readFlags().pro) openWhenReady()
