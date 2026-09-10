// HUD：开始页（按钮自己变状态，没有独立错误页）、引导 + 两根进度条、右上角三钮、
// 手动模式（横幅 + 圆钮）、toast、空闲暂停。
// 所有文案来自 copy.ts，不要在这里写死中文。

import { copy } from './copy'
import './drawer'

export interface HudCallbacks {
  onStart: () => void
  onFallback: () => void
  onReconnect: () => void
  onExit: () => void
  onManualTap: () => void
  onManualHold: () => void
  /** 短按 = 基础设置；长按 ≥ 600 ms = 展开触发阈值 */
  onGear: (advanced: boolean) => void
  onResume: () => void
}

export type StartState =
  | { kind: 'idle' }
  | { kind: 'camera' }
  | { kind: 'model'; pct?: number }
  | { kind: 'warmup' }
  | { kind: 'failed'; reason: 'denied' | 'timeout' | 'unsupported' | 'modelFail' }

const HOLD_DELAY = 350
const HOLD_REPEAT = 500
const GEAR_LONG_PRESS = 600

export class Hud {
  private root: HTMLElement
  private cb: HudCallbacks
  private video: HTMLVideoElement
  private fx: HTMLCanvasElement

  private startPage!: HTMLElement
  private startBtn!: HTMLButtonElement
  private startNote!: HTMLElement
  private startSteps!: HTMLElement
  private startRetry!: HTMLButtonElement
  private previewWrap!: HTMLElement

  private topbar!: HTMLElement
  private uiDot!: HTMLButtonElement
  private guideWrap!: HTMLElement
  private guideText!: HTMLElement
  private smileFill!: HTMLElement
  private laughFill!: HTMLElement
  private statusEl!: HTMLElement
  private banner!: HTMLElement
  private bannerBtn!: HTMLButtonElement
  private manualBtn!: HTMLButtonElement
  private manualHint!: HTMLElement
  private shareBtn!: HTMLButtonElement
  private toastEl!: HTMLElement
  private pausedEl!: HTMLElement
  private debugEl!: HTMLElement

  private holdTimer: number | null = null
  private repeatTimer: number | null = null
  private didHold = false
  private sharing = false
  private toastTimer = 0
  private startHideTimer = 0
  private guideHideTimer = 0
  private uiHidden = false

  constructor(root: HTMLElement, cb: HudCallbacks) {
    this.root = root
    this.cb = cb
    this.video = document.getElementById('cam') as HTMLVideoElement
    this.fx = document.getElementById('fx') as HTMLCanvasElement
    this.build()
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="start" id="startPage">
        <div class="start-inner">
          <div class="preview" id="previewWrap" hidden>
            <img id="previewImg" alt="${copy.start.previewAlt}" />
          </div>
          <div class="start-copy">
          <h1 class="start-title">${copy.start.title}</h1>
          <p class="start-sub">${copy.start.subtitle}</p>
          <button class="btn-primary start-btn" id="startBtn">
            <span class="spinner" aria-hidden="true"></span>
            <span class="start-btn-label">${copy.start.button}</span>
          </button>
          <p class="start-note" id="startNote" hidden></p>
          <p class="start-steps" id="startSteps" hidden></p>
          <button type="button" class="start-link" id="startRetry" hidden>${copy.start.retryCamera}</button>
          </div>
        </div>
        <p class="start-cam"><span class="start-cam-dot" aria-hidden="true"></span>${copy.start.needCamera}</p>
        <p class="start-privacy">${copy.start.liveDemo}</p>
      </div>

      <div class="topbar" id="topbar" hidden>
        <button class="icon-btn" id="hideBtn" aria-label="${copy.hud.hideUi}" title="${copy.hud.hideUi}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="icon-btn" id="gearBtn" aria-label="${copy.hud.gear}" title="${copy.hud.gear}">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.4" class="knob"/>
            <line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.4" class="knob"/>
            <line x1="4" y1="17" x2="20" y2="17"/><circle cx="11" cy="17" r="2.4" class="knob"/>
          </svg>
        </button>
        <button class="icon-btn" id="exitBtn" aria-label="${copy.hud.exit}" title="${copy.hud.exit}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <button class="ui-dot" id="uiDot" aria-label="${copy.hud.showUi}" hidden></button>

      <div class="banner" id="banner" hidden>
        <span class="banner-dot" aria-hidden="true"></span>
        <span class="banner-text">${copy.manual.banner}</span>
        <span class="banner-rule" aria-hidden="true"></span>
        <button class="banner-btn" id="reconnectBtn">
          <span class="banner-btn-label">${copy.manual.reconnect}</span>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <path d="M1.8 6.5a4.7 4.7 0 1 0 1.5-3.4"/>
            <path d="M1.6 2v3h3"/>
          </svg>
        </button>
      </div>

      <p class="status" id="statusEl" hidden></p>

      <div class="guide" id="guideWrap" hidden>
        <p class="guide-text" id="guideText"></p>
        <div class="guide-bars">
          <div class="guide-bar-row"><span>${copy.guide.smileBar}</span><div class="guide-bar" data-phase="smile"><i id="smileFill"></i></div></div>
          <div class="guide-bar-row"><span>${copy.guide.laughBar}</span><div class="guide-bar" data-phase="laugh"><i id="laughFill"></i></div></div>
        </div>
      </div>

      <p class="toast" id="toastEl" role="status" hidden></p>

      <p class="manual-hint" id="manualHint" hidden>
        <span class="manual-hint-idle">${copy.hud.manualHint}</span>
        <span class="manual-hint-hold">${copy.hud.manualRelease}</span>
      </p>
      <button class="manual" id="manualBtn" aria-label="${copy.hud.manualHint}" hidden>
        <span class="manual-dot"></span>
        <svg class="manual-ring" viewBox="0 0 68 68" aria-hidden="true">
          <circle class="manual-ring-track" cx="34" cy="34" r="31"></circle>
          <circle class="manual-ring-fill" cx="34" cy="34" r="31"></circle>
        </svg>
      </button>

      <button class="share" id="shareBtn" aria-label="${copy.hud.share}" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>
        </svg>
      </button>

      <button type="button" class="paused" id="pausedEl" hidden>
        <span class="paused-title">${copy.status.idleTitle}</span>
        <span class="paused-hint">${copy.status.idleHint}</span>
      </button>

      <pre class="debug" id="debugEl" hidden></pre>
    `
    const $ = <T extends HTMLElement>(id: string) => this.root.querySelector(`#${id}`) as T
    this.startPage = $('startPage')
    this.startBtn = $('startBtn')
    this.startNote = $('startNote')
    this.startSteps = $('startSteps')
    this.startRetry = $('startRetry')
    this.previewWrap = $('previewWrap')
    this.topbar = $('topbar')
    this.uiDot = $('uiDot')
    this.guideWrap = $('guideWrap')
    this.guideText = $('guideText')
    this.smileFill = $('smileFill')
    this.laughFill = $('laughFill')
    this.statusEl = $('statusEl')
    this.banner = $('banner')
    this.bannerBtn = $('reconnectBtn')
    this.manualBtn = $('manualBtn')
    this.manualHint = $('manualHint')
    this.shareBtn = $('shareBtn')
    this.toastEl = $('toastEl')
    this.pausedEl = $('pausedEl')
    this.debugEl = $('debugEl')

    this.startBtn.addEventListener('click', () => {
      if (this.startBtn.dataset.state === 'failed') this.cb.onFallback()
      else this.cb.onStart()
    })
    this.startRetry.addEventListener('click', () => this.cb.onReconnect())
    this.bannerBtn.addEventListener('click', () => this.cb.onReconnect())
    $('exitBtn').addEventListener('click', () => this.cb.onExit())
    $('hideBtn').addEventListener('click', () => this.setUiHidden(true))
    this.uiDot.addEventListener('click', () => this.setUiHidden(false))
    this.shareBtn.addEventListener('click', () => void this.shareFrame())
    this.pausedEl.addEventListener('click', () => this.cb.onResume())
    this.bindGear($('gearBtn') as HTMLButtonElement)
    this.bindManual()
    this.bindPreview()
  }

  // ---------- 设置键：短按基础，长按高级 ----------

  private bindGear(btn: HTMLButtonElement): void {
    let timer = 0
    let long = false
    let downAt = 0
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      long = false
      downAt = performance.now()
      timer = window.setTimeout(() => {
        long = true
        this.cb.onGear(true)
      }, GEAR_LONG_PRESS)
    })
    const end = () => {
      if (timer) window.clearTimeout(timer)
      timer = 0
    }
    btn.addEventListener('pointerup', () => {
      end()
      if (long) return
      // 主线程被检测卡住时 setTimeout 会迟到；按实际按住时长兜底，别把长按当成短按
      if (performance.now() - downAt >= GEAR_LONG_PRESS) this.cb.onGear(true)
      else this.cb.onGear(false)
    })
    btn.addEventListener('pointercancel', end)
    btn.addEventListener('pointerleave', end)
    btn.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  private bindManual(): void {
    const b = this.manualBtn
    const down = (e: Event) => {
      e.preventDefault()
      this.didHold = false
      b.classList.add('is-holding')
      this.holdTimer = window.setTimeout(() => {
        this.didHold = true
        this.cb.onManualHold()
        this.repeatTimer = window.setInterval(() => this.cb.onManualHold(), HOLD_REPEAT)
      }, HOLD_DELAY)
    }
    const stop = () => {
      if (this.holdTimer !== null) clearTimeout(this.holdTimer)
      if (this.repeatTimer !== null) clearInterval(this.repeatTimer)
      this.holdTimer = null
      this.repeatTimer = null
      b.classList.remove('is-holding')
    }
    b.addEventListener('pointerdown', down)
    b.addEventListener('pointerup', () => {
      stop()
      if (!this.didHold) this.cb.onManualTap()
      this.didHold = false
    })
    b.addEventListener('pointercancel', stop)
    b.addEventListener('pointerleave', stop)
  }

  /** 开始页封面图：文件不存在就整块消失，不留碎图标、不占布局。 */
  private bindPreview(): void {
    const img = this.previewWrap.querySelector('img') as HTMLImageElement
    img.addEventListener('load', () => (this.previewWrap.hidden = false))
    img.addEventListener('error', () => (this.previewWrap.hidden = true))
    img.src = 'preview.jpg'
  }

  // ---------- 开始页 ----------

  /** 开始页只有一个按钮，它自己变四种状态；失败也在这一页，没有独立错误页。 */
  setStartState(st: StartState): void {
    const label = this.startBtn.querySelector('.start-btn-label') as HTMLElement
    const busy = st.kind === 'camera' || st.kind === 'model' || st.kind === 'warmup'
    this.startBtn.dataset.state = st.kind
    this.startBtn.disabled = busy
    this.startBtn.classList.toggle('is-busy', busy)
    this.startNote.hidden = true
    this.startSteps.hidden = true
    this.startRetry.hidden = true

    if (st.kind === 'idle') label.textContent = copy.start.button
    else if (st.kind === 'camera') label.textContent = copy.start.stageCamera
    else if (st.kind === 'warmup') label.textContent = copy.start.stageWarmup
    else if (st.kind === 'model') {
      label.textContent = copy.start.stageModel
      this.startNote.hidden = false
      const t = st.pct === undefined ? copy.start.modelLine : `${copy.start.modelLine} ${st.pct}%`
      if (this.startNote.textContent !== t) this.startNote.textContent = t
    } else {
      label.textContent = copy.start.noCamera
      this.startNote.hidden = false
      this.startNote.textContent = copy.error[st.reason]
      if (st.reason === 'denied') {
        this.startSteps.hidden = false
        this.startSteps.textContent = this.deniedSteps()
      }
      this.startRetry.hidden = false
    }
  }

  private deniedSteps(): string {
    const ua = navigator.userAgent
    const s = copy.error.deniedSteps
    const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))
    if (iOS) return /CriOS|EdgiOS|FxiOS/.test(ua) ? s.iosOther : s.iosSafari
    if (/Android/.test(ua)) return s.androidChrome
    if (/Firefox/.test(ua)) return s.desktopFirefox
    if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return s.desktopSafari
    if (/Chrome|Chromium|Edg/.test(ua)) return s.desktopChrome
    return s.generic
  }

  hideStart(): void {
    this.startPage.classList.add('is-gone')
    if (this.startHideTimer) window.clearTimeout(this.startHideTimer)
    this.startHideTimer = window.setTimeout(() => {
      this.startPage.hidden = true
      this.startHideTimer = 0
    }, 420)
  }

  /** 退出回开始页：把主画面的所有控件收掉。 */
  showStart(): void {
    if (this.startHideTimer) {
      window.clearTimeout(this.startHideTimer)
      this.startHideTimer = 0
    }
    if (this.guideHideTimer) {
      window.clearTimeout(this.guideHideTimer)
      this.guideHideTimer = 0
    }
    this.setUiHidden(false)
    this.topbar.hidden = true
    this.manualBtn.hidden = true
    this.manualHint.hidden = true
    this.shareBtn.hidden = true
    this.banner.hidden = true
    this.guideWrap.hidden = true
    this.statusEl.hidden = true
    this.pausedEl.hidden = true
    this.setStartState({ kind: 'idle' })
    this.startPage.hidden = false
    requestAnimationFrame(() => this.startPage.classList.remove('is-gone'))
  }

  // ---------- 主画面控件 ----------

  /** 手动钮只在没有摄像头时出现——它是给摄像头失败的评审的后门，不是给用户的。 */
  showControls(opts: { camera: boolean; clean: boolean }): void {
    this.topbar.hidden = opts.clean
    this.manualBtn.hidden = opts.camera
    this.manualHint.hidden = opts.camera
    this.shareBtn.hidden = !opts.camera
    this.banner.hidden = opts.camera
    this.setReconnecting(false)
  }

  setReconnecting(on: boolean): void {
    this.bannerBtn.disabled = on
    const label = this.bannerBtn.querySelector('.banner-btn-label')
    const text = on ? copy.manual.connecting : copy.manual.reconnect
    if (label) label.textContent = text
    else this.bannerBtn.textContent = text
  }

  setUiHidden(on: boolean): void {
    this.uiHidden = on
    this.root.classList.toggle('is-ui-hidden', on)
    this.uiDot.hidden = !on
  }

  get isUiHidden(): boolean {
    return this.uiHidden
  }

  // ---------- 截图分享 ----------

  private composeFrame(): HTMLCanvasElement | null {
    const w = this.fx.width
    const h = this.fx.height
    if (!w || !h) return null
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const ctx = off.getContext('2d')
    if (!ctx) return null
    const vw = this.video.videoWidth
    const vh = this.video.videoHeight
    if (vw > 0 && vh > 0) {
      ctx.save()
      ctx.translate(w, 0)
      ctx.scale(-1, 1)
      const scale = Math.max(w / vw, h / vh)
      const sw = w / scale
      const sh = h / scale
      ctx.drawImage(this.video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h)
      ctx.restore()
    }
    ctx.drawImage(this.fx, 0, 0)
    return off
  }

  private async shareFrame(): Promise<void> {
    if (this.sharing || !this.video.srcObject) return
    const off = this.composeFrame()
    if (!off) return
    this.sharing = true
    try {
      const blob = await new Promise<Blob | null>((resolve) => off.toBlob(resolve, 'image/png'))
      if (!blob) {
        this.toast(copy.hud.shareFail)
        return
      }
      const file = new File([blob], 'smile-rain-fireworks.png', { type: 'image/png' })
      const payload = { files: [file], title: copy.hud.shareTitle }
      try {
        if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
          await navigator.share(payload)
          this.toast(copy.hud.shared)
          return
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
      URL.revokeObjectURL(url)
      this.toast(copy.hud.downloaded)
    } finally {
      this.sharing = false
    }
  }

  // ---------- 引导 + 两根进度条 ----------

  /** text: null = 整块隐藏；'' = 文字淡出、只留两根条 */
  setGuide(text: string | null, smile: number, laugh: number): void {
    if (text === null) {
      if (this.guideWrap.hidden || this.guideHideTimer) return
      this.guideWrap.classList.add('is-gone')
      this.guideHideTimer = window.setTimeout(() => {
        this.guideWrap.hidden = true
        this.guideWrap.classList.remove('is-gone')
        this.guideHideTimer = 0
      }, 500)
      return
    }
    if (this.guideHideTimer) {
      window.clearTimeout(this.guideHideTimer)
      this.guideHideTimer = 0
    }
    this.guideWrap.hidden = false
    this.guideWrap.classList.remove('is-gone')
    this.guideText.classList.toggle('is-off', text === '')
    if (text !== '' && this.guideText.textContent !== text) this.guideText.textContent = text
    this.smileFill.style.transform = `scaleX(${Math.max(0, Math.min(1, smile))})`
    this.laughFill.style.transform = `scaleX(${Math.max(0, Math.min(1, laugh))})`
  }

  // ---------- 提示 ----------

  toast(text: string): void {
    this.toastEl.hidden = false
    this.toastEl.textContent = text
    this.toastEl.classList.add('is-on')
    if (this.toastTimer) window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('is-on')
      this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), 300)
    }, 1800)
  }

  showPaused(on: boolean): void {
    this.pausedEl.hidden = !on
  }

  setStatus(text: string | null): void {
    if (!text) {
      this.statusEl.hidden = true
      return
    }
    this.statusEl.hidden = false
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text
  }

  setDebug(lines: string | null): void {
    if (!lines) {
      this.debugEl.hidden = true
      return
    }
    this.debugEl.hidden = false
    this.debugEl.textContent = lines
  }
}
