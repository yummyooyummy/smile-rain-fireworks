// HUD：开始页、引导提示 + 进度条、手动触发按钮、错误页、调试面板。
// 结构和交互先做到可用，视觉细节交给 Cursor 打磨（见 TODO-for-cursor.md）。
// 所有文案来自 copy.ts，不要在这里写死中文。

import { copy } from './copy'
import './drawer'

export interface HudCallbacks {
  onStart: () => void
  onManualTap: () => void
  onManualHold: () => void
  onGearClick: () => void
  onFallback: () => void
}

const HOLD_DELAY = 350
const HOLD_REPEAT = 500

export class Hud {
  private root: HTMLElement
  private cb: HudCallbacks

  private startPage!: HTMLElement
  private startBtn!: HTMLButtonElement
  private guideWrap!: HTMLElement
  private guideText!: HTMLElement
  private guideBar!: HTMLElement
  private guideFill!: HTMLElement
  private statusEl!: HTMLElement
  private manualBtn!: HTMLButtonElement
  private gearBtn!: HTMLButtonElement
  private errorPage!: HTMLElement
  private debugEl!: HTMLElement

  private holdTimer: number | null = null
  private repeatTimer: number | null = null
  private didHold = false

  constructor(root: HTMLElement, cb: HudCallbacks) {
    this.root = root
    this.cb = cb
    this.build()
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="start" id="startPage">
        <div class="start-inner">
          <h1 class="start-title">${copy.start.title}</h1>
          <p class="start-sub">${copy.start.subtitle}</p>
          <button class="btn-primary" id="startBtn">${copy.start.button}</button>
          <p class="start-privacy">${copy.start.privacy}</p>
        </div>
      </div>

      <div class="guide" id="guideWrap" hidden>
        <p class="guide-text" id="guideText"></p>
        <div class="guide-bar" id="guideBar"><i id="guideFill"></i></div>
      </div>

      <p class="status" id="statusEl" hidden></p>

      <button class="manual" id="manualBtn" aria-label="${copy.hud.manualHint}" hidden>
        <span class="manual-dot"></span>
      </button>

      <button class="gear" id="gearBtn" aria-label="${copy.hud.gear}" hidden>◔</button>

      <div class="error" id="errorPage" hidden></div>

      <pre class="debug" id="debugEl" hidden></pre>
    `
    const $ = <T extends HTMLElement>(id: string) => this.root.querySelector(`#${id}`) as T

    this.startPage = $('startPage')
    this.startBtn = $('startBtn')
    this.guideWrap = $('guideWrap')
    this.guideText = $('guideText')
    this.guideBar = $('guideBar')
    this.guideFill = $('guideFill')
    this.statusEl = $('statusEl')
    this.manualBtn = $('manualBtn')
    this.gearBtn = $('gearBtn')
    this.errorPage = $('errorPage')
    this.debugEl = $('debugEl')

    this.startBtn.addEventListener('click', () => this.cb.onStart())
    this.gearBtn.addEventListener('click', () => this.cb.onGearClick())
    this.bindManual()
  }

  private bindManual(): void {
    const b = this.manualBtn
    const down = (e: Event) => {
      e.preventDefault()
      this.didHold = false
      this.holdTimer = window.setTimeout(() => {
        this.didHold = true
        this.cb.onManualHold()
        this.repeatTimer = window.setInterval(() => this.cb.onManualHold(), HOLD_REPEAT)
      }, HOLD_DELAY)
    }
    const up = () => {
      if (this.holdTimer !== null) clearTimeout(this.holdTimer)
      if (this.repeatTimer !== null) clearInterval(this.repeatTimer)
      this.holdTimer = null
      this.repeatTimer = null
      if (!this.didHold) this.cb.onManualTap()
      this.didHold = false
    }
    b.addEventListener('pointerdown', down)
    b.addEventListener('pointerup', up)
    b.addEventListener('pointercancel', up)
    b.addEventListener('pointerleave', () => {
      if (this.holdTimer !== null) clearTimeout(this.holdTimer)
      if (this.repeatTimer !== null) clearInterval(this.repeatTimer)
      this.holdTimer = null
      this.repeatTimer = null
      this.didHold = false
    })
  }

  // ---------- 开始页 ----------

  setLoading(on: boolean): void {
    this.startBtn.disabled = on
    this.startBtn.textContent = on ? copy.start.loading : copy.start.button
  }

  hideStart(): void {
    this.startPage.classList.add('is-gone')
    window.setTimeout(() => {
      this.startPage.hidden = true
    }, 420)
  }

  // ---------- 主画面控件 ----------

  showControls(opts: { gear: boolean }): void {
    this.manualBtn.hidden = false
    this.gearBtn.hidden = !opts.gear
  }

  // ---------- 引导 ----------

  setGuide(text: string | null, progress: number, phase: 'smile' | 'laugh' | 'none'): void {
    if (text === null) {
      if (!this.guideWrap.hidden) {
        this.guideWrap.classList.add('is-gone')
        window.setTimeout(() => {
          this.guideWrap.hidden = true
          this.guideWrap.classList.remove('is-gone')
        }, 500)
      }
      return
    }
    this.guideWrap.hidden = false
    this.guideWrap.classList.remove('is-gone')
    // 空字符串 = 引导已走完，只保留进度条这个常驻反馈
    this.guideText.hidden = text === ''
    if (text !== '' && this.guideText.textContent !== text) this.guideText.textContent = text
    this.guideBar.hidden = false
    this.guideBar.dataset.phase = phase
    this.guideFill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`
  }

  // ---------- 状态提示 ----------

  setStatus(text: string | null): void {
    if (!text) {
      this.statusEl.hidden = true
      return
    }
    this.statusEl.hidden = false
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text
  }

  // ---------- 错误页 ----------

  showError(kind: 'denied' | 'unsupported' | 'modelFail'): void {
    const map = {
      denied: [copy.error.denied, copy.error.deniedHint],
      unsupported: [copy.error.unsupported, copy.error.unsupportedHint],
      modelFail: [copy.error.modelFail, copy.error.modelFailHint],
    } as const
    const [title, hint] = map[kind]
    this.errorPage.hidden = false
    this.errorPage.innerHTML = `
      <div class="error-inner">
        <h2>${title}</h2>
        <p>${hint}</p>
        <div class="error-actions">
          <button class="btn-ghost" id="errRetry">${copy.error.retry}</button>
          <button class="btn-primary" id="errFallback">${copy.error.fallback}</button>
        </div>
      </div>`
    this.errorPage.querySelector('#errRetry')?.addEventListener('click', () => location.reload())
    this.errorPage.querySelector('#errFallback')?.addEventListener('click', () => {
      this.errorPage.hidden = true
      this.cb.onFallback()
    })
  }

  // ---------- 调试 ----------

  setDebug(lines: string | null): void {
    if (!lines) {
      this.debugEl.hidden = true
      return
    }
    this.debugEl.hidden = false
    this.debugEl.textContent = lines
  }
}
