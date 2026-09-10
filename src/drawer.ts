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
    <div class="drawer-handle" aria-hidden="true"><i></i></div>
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
      <button type="button" class="btn-ghost drawer-replay" id="drawerReplay">${copy.drawer.replayGuide}</button>
      <button type="button" class="btn-ghost drawer-export" id="drawerExport">${copy.drawer.exportJson}</button>
      <p class="drawer-feedback" id="drawerFeedback" hidden></p>
      <p class="drawer-tier">${copy.drawer.tier} <span id="drawerTier"></span></p>
    </div>
  </div>
`

document.body.appendChild(panel)

const sheet = panel.querySelector('.drawer-sheet') as HTMLElement
const handle = panel.querySelector('.drawer-handle') as HTMLElement
const replayBtn = panel.querySelector('#drawerReplay') as HTMLButtonElement
const closeBtn = panel.querySelector('#drawerClose') as HTMLButtonElement
const exportBtn = panel.querySelector('#drawerExport') as HTMLButtonElement
const feedback = panel.querySelector('#drawerFeedback') as HTMLElement
const tierEl = panel.querySelector('#drawerTier') as HTMLElement

let open = false
let tierTimer = 0
let feedbackTimer = 0
// 抽屉打开时往 history 里压一条，手机的返回手势/返回键就变成「关抽屉」而不是「离开页面」。
// 不这么做，用户在手机上打开抽屉后返回，直接退出整个 demo，摄像头授权还得重来一遍。
let pushed = false
// 打开前谁有焦点，关上还给谁——键盘用户关掉抽屉后不该被丢回页面顶端
let lastFocus: HTMLElement | null = null

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

function setOpen(next: boolean, fromPop = false): void {
  if (open === next) {
    if (next) syncFromConfig()
    return
  }
  open = next
  if (next && !fromPop) {
    history.pushState({ drawer: true }, '')
    pushed = true
  } else if (!next) {
    const shouldPop = pushed && !fromPop
    pushed = false
    if (shouldPop) history.back()
  }
  panel.classList.toggle('is-open', next)
  panel.setAttribute('aria-hidden', next ? 'false' : 'true')
  if (next) {
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    syncFromConfig()
    window.setTimeout(() => closeBtn.focus({ preventScroll: true }), 60)
    if (tierTimer) window.clearInterval(tierTimer)
    tierTimer = window.setInterval(() => {
      const fx = getFx()
      if (fx) tierEl.textContent = fx.getTier()
    }, 500)
  } else {
    if (tierTimer) {
      window.clearInterval(tierTimer)
      tierTimer = 0
    }
    sheet.style.transform = ''
    lastFocus?.focus({ preventScroll: true })
    lastFocus = null
  }
}

// ---------- 焦点陷阱 ----------
// 抽屉是模态的：Tab 不该跑到它后面那层去，否则键盘用户会「掉出」抽屉，
// 而背后那层此时是不可见也不该被操作的。
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

function trapTab(e: KeyboardEvent): void {
  if (!open || e.key !== 'Tab') return
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null,
  )
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || !panel.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
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

replayBtn.addEventListener('click', () => {
  window.dispatchEvent(new CustomEvent('replay-guide'))
  setOpen(false)
})

// 点抽屉外面关闭。齿轮要排除掉，否则「点齿轮关闭」和「点外面关闭」会互相抵消。
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!open) return
    const t = e.target
    if (!(t instanceof Node)) return
    if (panel.contains(t)) return
    if (t instanceof Element && t.closest('.gear')) return
    setOpen(false)
  },
  true,
)

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && open) {
    setOpen(false)
    return
  }
  trapTab(e)
})

// ---------- 手机：下拉把手关闭 ----------
// 底部抽屉在手机上，最自然的关闭动作就是往下一划。没有它，唯一的出口是右上角
// 那个 32px 的 ×，单手够不到。
let dragY = 0
let dragging = false

handle.addEventListener('pointerdown', (e) => {
  if (!open) return
  dragging = true
  dragY = e.clientY
  handle.setPointerCapture(e.pointerId)
  sheet.style.transition = 'none'
})

handle.addEventListener('pointermove', (e) => {
  if (!dragging) return
  const dy = Math.max(0, e.clientY - dragY)
  sheet.style.transform = `translateY(${dy}px)`
})

const endDrag = (e: PointerEvent) => {
  if (!dragging) return
  dragging = false
  handle.releasePointerCapture?.(e.pointerId)
  sheet.style.transition = ''
  const dy = Math.max(0, e.clientY - dragY)
  // 划过 80px 或者划过自身高度的四分之一就算要关
  if (dy > Math.min(80, sheet.getBoundingClientRect().height * 0.25)) {
    sheet.style.transform = ''
    setOpen(false)
  } else {
    sheet.style.transform = ''
  }
}

handle.addEventListener('pointerup', endDrag)
handle.addEventListener('pointercancel', endDrag)

window.addEventListener('popstate', () => {
  if (open) setOpen(false, true)
})

function openWhenReady(frames = 0): void {
  if (getFx()) {
    setOpen(true)
    return
  }
  if (frames < 60) requestAnimationFrame(() => openWhenReady(frames + 1))
}

if (readFlags().pro) openWhenReady()
