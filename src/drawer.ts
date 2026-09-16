// 高级模式抽屉（L3）。只通过预留接口读写配置，不碰引擎内部：
//   window 'open-drawer' 打开；window.__fx = { getConfig, setConfig, getTier }
// 文案全部来自 copy.ts；桌面右侧滑入 ≤320px，手机底部滑入 ≤60vh，无全屏遮罩。

import {
  CONTROLS,
  PALETTE_PRESETS,
  posToValue,
  readFlags,
  valueToPos,
  type EffectConfig,
  type SliderKey,
} from './config'
import { copy } from './copy'

interface FxBridge {
  getConfig: () => EffectConfig
  setConfig: (next: EffectConfig) => void
  getTier: () => 'low' | 'mid' | 'high'
}

function meta(key: SliderKey) {
  return CONTROLS.find((c) => c.key === key) as (typeof CONTROLS)[number]
}

function getFx(): FxBridge | undefined {
  return (window as unknown as { __fx?: FxBridge }).__fx
}

/** 调试模式下才显示的真实数值 */
function rawText(key: SliderKey, n: number): string {
  return meta(key).step >= 1 ? String(Math.round(n)) : n.toFixed(2)
}

const panel = document.createElement('aside')
panel.className = 'drawer'
panel.setAttribute('aria-hidden', 'true')

const sliderMarkup = CONTROLS.map(
  (c) => `
    <label class="drawer-field">
      <span class="drawer-field-head">
        <span>${copy.drawer.controls[c.key].label}</span>
        <span class="drawer-val" data-val="${c.key}" hidden></span>
      </span>
      <input type="range" data-slider="${c.key}" min="0" max="100" step="1" />
      <span class="drawer-ends"><i>${copy.drawer.controls[c.key].min}</i><i>${copy.drawer.controls[c.key].max}</i></span>
    </label>`,
).join('')

const paletteMarkup = PALETTE_PRESETS.map(
  (p) => `
    <button type="button" class="drawer-swatch" data-palette="${p.id}" aria-label="${copy.drawer.palette[p.id]}">
      <span class="drawer-swatch-dots">
        ${p.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}
      </span>
      <em>${copy.drawer.palette[p.id]}</em>
    </button>`,
).join('')

panel.innerHTML = `
  <div class="drawer-sheet">
    <div class="drawer-handle" aria-hidden="true"><i></i></div>
    <header class="drawer-head">
      <h2 class="drawer-title">${copy.drawer.title}</h2>
      <button type="button" class="drawer-close" id="drawerClose" aria-label="${copy.drawer.close}">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path d="M4.8 4.8l8.4 8.4M13.2 4.8l-8.4 8.4"/>
        </svg>
      </button>
    </header>
    <div class="drawer-body">
      <p class="drawer-hint">${copy.drawer.hint}</p>
      ${sliderMarkup}

      <div class="drawer-palette">
        <span class="drawer-sub">${copy.drawer.paletteTitle}</span>
        <div class="drawer-swatches">${paletteMarkup}</div>
      </div>

      <label class="drawer-switch">
        <span>${copy.drawer.personSeg}<em>${copy.drawer.personSegHint}</em></span>
        <input type="checkbox" data-toggle="personSeg" />
      </label>

      <button type="button" class="drawer-more" id="drawerMore" aria-expanded="false">
        ${copy.drawer.advancedTitle}<span aria-hidden="true">›</span>
      </button>
      <section class="drawer-advanced" id="drawerAdvanced" hidden>
        <label class="drawer-switch">
          <span>${copy.drawer.showCollider}</span>
          <input type="checkbox" data-toggle="showCollider" />
        </label>
        <label class="drawer-switch">
          <span>${copy.drawer.showDebug}</span>
          <input type="checkbox" data-toggle="showDebug" />
        </label>
        <button type="button" class="btn-primary drawer-export" id="drawerExport">${copy.drawer.copyConfig}</button>
        <p class="drawer-feedback" id="drawerFeedback" hidden></p>
      </section>
    </div>
  </div>
`

document.body.appendChild(panel)

const sheet = panel.querySelector('.drawer-sheet') as HTMLElement
const handle = panel.querySelector('.drawer-handle') as HTMLElement
const closeBtn = panel.querySelector('#drawerClose') as HTMLButtonElement
const exportBtn = panel.querySelector('#drawerExport') as HTMLButtonElement
const feedback = panel.querySelector('#drawerFeedback') as HTMLElement
const moreBtn = panel.querySelector('#drawerMore') as HTMLButtonElement
const advanced = panel.querySelector('#drawerAdvanced') as HTMLElement

let open = false
let feedbackTimer = 0
// 抽屉打开时往 history 里压一条，手机的返回手势/返回键就变成「关抽屉」而不是「离开页面」。
// 不这么做，用户在手机上打开抽屉后返回，直接退出整个 demo，摄像头授权还得重来一遍。
let pushed = false
// 打开前谁有焦点，关上还给谁——键盘用户关掉抽屉后不该被丢回页面顶端
let lastFocus: HTMLElement | null = null

function sliderFill(input: HTMLInputElement): void {
  const min = Number(input.min)
  const max = Number(input.max)
  const val = Number(input.value)
  const p = max === min ? 0 : ((val - min) / (max - min)) * 100
  input.style.setProperty('--p', `${p}%`)
}

function syncFromConfig(): void {
  const fx = getFx()
  if (!fx) return
  const cfg = fx.getConfig()
  for (const c of CONTROLS) {
    const input = panel.querySelector<HTMLInputElement>(`[data-slider="${c.key}"]`)
    const val = panel.querySelector<HTMLElement>(`[data-val="${c.key}"]`)
    if (!input || !val) continue
    input.value = String(Math.round(valueToPos(c, cfg[c.key])))
    val.hidden = !cfg.showDebug
    val.textContent = rawText(c.key, cfg[c.key])
    sliderFill(input)
  }
  // 配色：只认预设里的色相；存过的旧值（比如已删掉的极光 140）一律归暖金
  let best: (typeof PALETTE_PRESETS)[number] = PALETTE_PRESETS[0]
  for (const p of PALETTE_PRESETS) if (p.hue === cfg.hueShift) best = p
  if (best.hue !== cfg.hueShift) patchConfig({ hueShift: best.hue })
  for (const btn of panel.querySelectorAll<HTMLElement>('[data-palette]')) {
    btn.classList.toggle('is-on', btn.dataset.palette === best.id)
  }
  const debug = panel.querySelector<HTMLInputElement>('[data-toggle="showDebug"]')
  const seg = panel.querySelector<HTMLInputElement>('[data-toggle="personSeg"]')
  const col = panel.querySelector<HTMLInputElement>('[data-toggle="showCollider"]')
  if (debug) debug.checked = cfg.showDebug
  if (seg) seg.checked = cfg.personSeg
  if (col) col.checked = cfg.showCollider
}

function setAdvanced(on: boolean): void {
  advanced.hidden = !on
  moreBtn.setAttribute('aria-expanded', on ? 'true' : 'false')
  moreBtn.classList.toggle('is-open', on)
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
  } else {
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
  for (const c of CONTROLS) {
    const val = panel.querySelector<HTMLElement>(`[data-val="${c.key}"]`)
    if (val) {
      val.hidden = !cfg.showDebug
      val.textContent = rawText(c.key, cfg[c.key])
    }
  }
}

panel.addEventListener('input', (e) => {
  const t = e.target
  if (!(t instanceof HTMLInputElement)) return
  const slider = t.dataset.slider as SliderKey | undefined
  if (slider) {
    patchConfig({ [slider]: posToValue(meta(slider), Number(t.value)) })
    sliderFill(t)
    return
  }
  const toggle = t.dataset.toggle
  if (toggle === 'showDebug') patchConfig({ showDebug: t.checked })
  if (toggle === 'personSeg') patchConfig({ personSeg: t.checked })
  if (toggle === 'showCollider') patchConfig({ showCollider: t.checked })
})

async function exportConfig(): Promise<void> {
  const fx = getFx()
  if (!fx) return
  const json = JSON.stringify(fx.getConfig(), null, 2)
  try {
    await navigator.clipboard.writeText(json)
  } catch {
    // 剪贴板不可用（http / 权限）时退回下载
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'effect.json'
    a.click()
    URL.revokeObjectURL(url)
  }
  feedback.hidden = false
  feedback.textContent = copy.drawer.copied
  if (feedbackTimer) window.clearTimeout(feedbackTimer)
  feedbackTimer = window.setTimeout(() => (feedback.hidden = true), 2000)
}

moreBtn.addEventListener('click', () => setAdvanced(advanced.hidden))

panel.addEventListener('click', (e) => {
  const t = e.target
  if (!(t instanceof Element)) return
  const sw = t.closest<HTMLElement>('[data-palette]')
  if (!sw) return
  const preset = PALETTE_PRESETS.find((p) => p.id === sw.dataset.palette)
  if (!preset) return
  patchConfig({ hueShift: preset.hue })
  for (const btn of panel.querySelectorAll<HTMLElement>('[data-palette]')) {
    btn.classList.toggle('is-on', btn === sw)
  }
})

closeBtn.addEventListener('click', () => setOpen(false))
exportBtn.addEventListener('click', () => void exportConfig())

window.addEventListener('open-drawer', () => setOpen(!open))

// 点抽屉外面关闭。齿轮要排除掉，否则「点齿轮关闭」和「点外面关闭」会互相抵消。
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!open) return
    const t = e.target
    if (!(t instanceof Node)) return
    if (panel.contains(t)) return
    if (t instanceof Element && t.closest('.topbar')) return
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
    setAdvanced(true) // ?mode=pro 是给开发/运营的入口，直接展开高级设置
    setOpen(true)
    return
  }
  if (frames < 60) requestAnimationFrame(() => openWhenReady(frames + 1))
}

// 等进入主画面再自动展开：在开始页就弹出来会把「开始」按钮盖住（手机上整个盖满）
if (readFlags().pro) window.addEventListener('scene-enter', () => openWhenReady(), { once: true })
