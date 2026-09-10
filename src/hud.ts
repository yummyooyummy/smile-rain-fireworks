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
  /** 重试 / 重新连接摄像头：重跑一次授权与模型初始化，不刷新页面 */
  onReconnect: () => void
  onSkipGuide: () => void
  onResume: () => void
}

const HOLD_DELAY = 350
const HOLD_REPEAT = 500

export class Hud {
  private root: HTMLElement
  private cb: HudCallbacks

  private startPage!: HTMLElement
  private startBtn!: HTMLButtonElement
  private previewWrap!: HTMLElement
  private loadWrap!: HTMLElement
  private loadFill!: HTMLElement
  private loadText!: HTMLElement
  private banner!: HTMLElement
  private bannerBtn!: HTMLButtonElement
  private guideWrap!: HTMLElement
  private guideRow!: HTMLElement
  private guideText!: HTMLElement
  private guideSkip!: HTMLButtonElement
  private toastEl!: HTMLElement
  private pausedEl!: HTMLElement
  private guideBar!: HTMLElement
  private guideFill!: HTMLElement
  private statusEl!: HTMLElement
  private manualBtn!: HTMLButtonElement
  private shareBtn!: HTMLButtonElement
  private gearBtn!: HTMLButtonElement
  private errorPage!: HTMLElement
  private debugEl!: HTMLElement
  private video: HTMLVideoElement
  private fx: HTMLCanvasElement

  private holdTimer: number | null = null
  private repeatTimer: number | null = null
  private didHold = false
  private sharing = false

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
          <h1 class="start-title">${copy.start.title}</h1>
          <p class="start-sub">${copy.start.subtitle}</p>
          <div class="preview" id="previewWrap" hidden>
            <video id="previewVid" autoplay muted loop playsinline
                   aria-label="${copy.start.previewAlt}"></video>
          </div>
          <button class="btn-primary" id="startBtn">${copy.start.button}</button>
          <div class="load" id="loadWrap" hidden>
            <div class="load-bar"><i id="loadFill"></i></div>
            <p class="load-text" id="loadText"></p>
          </div>
          <p class="start-privacy">${copy.start.privacy}</p>
        </div>
      </div>

      <div class="guide" id="guideWrap" hidden>
        <div class="guide-row" id="guideRow">
          <p class="guide-text" id="guideText"></p>
          <button type="button" class="guide-skip" id="guideSkip">${copy.guide.skip}</button>
        </div>
        <div class="guide-bar" id="guideBar"><i id="guideFill"></i></div>
      </div>

      <p class="toast" id="toastEl" role="status" hidden></p>

      <button type="button" class="paused" id="pausedEl" hidden>
        <span class="paused-title">${copy.status.idleTitle}</span>
        <span class="paused-hint">${copy.status.idleHint}</span>
      </button>

      <div class="banner" id="banner" hidden>
        <span class="banner-dot" aria-hidden="true"></span>
        <span class="banner-text">${copy.manual.banner}</span>
        <button class="banner-btn" id="reconnectBtn">${copy.manual.reconnect}</button>
      </div>

      <p class="status" id="statusEl" hidden></p>

      <button class="manual" id="manualBtn" aria-label="${copy.hud.manualHint}" hidden>
        <span class="manual-dot"></span>
      </button>

      <button class="share" id="shareBtn" aria-label="${copy.hud.share}" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12" />
          <path d="M7 8l5-5 5 5" />
          <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
        </svg>
      </button>

      <button class="gear" id="gearBtn" aria-label="${copy.hud.gear}" title="${copy.hud.gear}" hidden>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <line x1="4" y1="7" x2="20" y2="7" /><circle cx="9" cy="7" r="2.4" fill="currentColor" stroke="none" />
          <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2.4" fill="currentColor" stroke="none" />
          <line x1="4" y1="17" x2="20" y2="17" /><circle cx="11" cy="17" r="2.4" fill="currentColor" stroke="none" />
        </svg>
      </button>

      <div class="error" id="errorPage" hidden></div>

      <pre class="debug" id="debugEl" hidden></pre>
    `
    const $ = <T extends HTMLElement>(id: string) => this.root.querySelector(`#${id}`) as T

    this.startPage = $('startPage')
    this.startBtn = $('startBtn')
    this.previewWrap = $('previewWrap')
    this.loadWrap = $('loadWrap')
    this.loadFill = $('loadFill')
    this.loadText = $('loadText')
    this.banner = $('banner')
    this.bannerBtn = $('reconnectBtn')
    this.guideWrap = $('guideWrap')
    this.guideRow = $('guideRow')
    this.guideText = $('guideText')
    this.guideSkip = $('guideSkip')
    this.toastEl = $('toastEl')
    this.pausedEl = $('pausedEl')
    this.guideBar = $('guideBar')
    this.guideFill = $('guideFill')
    this.statusEl = $('statusEl')
    this.manualBtn = $('manualBtn')
    this.shareBtn = $('shareBtn')
    this.gearBtn = $('gearBtn')
    this.errorPage = $('errorPage')
    this.debugEl = $('debugEl')

    this.startBtn.addEventListener('click', () => this.cb.onStart())
    this.gearBtn.addEventListener('click', () => this.cb.onGearClick())
    this.bannerBtn.addEventListener('click', () => this.cb.onReconnect())
    this.shareBtn.addEventListener('click', () => void this.shareFrame())
    this.guideSkip.addEventListener('click', () => this.cb.onSkipGuide())
    this.pausedEl.addEventListener('click', () => this.cb.onResume())
    this.bindManual()
    this.bindPreview()
  }

  /**
   * 开始页的玩法预览。视频文件还没录时（现在就是），这个槽位必须干净地消失，
   * 而不是留一个黑框或者一个碎图标——所以默认 hidden，只有真的能播才显示。
   * 用户开了「减少动态效果」时也不显示。
   */
  private bindPreview(): void {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const vid = this.previewWrap.querySelector('video') as HTMLVideoElement
    vid.addEventListener('canplay', () => {
      this.previewWrap.hidden = false
    })
    vid.addEventListener('error', () => {
      this.previewWrap.hidden = true
    })
    // 放在 src 赋值之前绑定，避免同步失败时事件已经过去了
    vid.src = 'preview.mp4'
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
    if (!on) this.setLoadingStage(null, 0)
  }

  /**
   * 加载进度。模型 4MB，国内网络下可能要十几秒——没有进度条时用户只会看到
   * 一个禁用的按钮，分不清「在加载」和「卡死了」，多半会刷新，然后重新等一遍。
   * pct 为 undefined 表示这一段拿不到 content-length，只显示文字不显示百分比。
   */
  setLoadingStage(text: string | null, progress: number, pct?: number): void {
    if (text === null) {
      this.loadWrap.hidden = true
      return
    }
    this.loadWrap.hidden = false
    const label = pct === undefined ? text : `${text} ${pct}%`
    if (this.loadText.textContent !== label) this.loadText.textContent = label
    this.loadFill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`
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
    this.shareBtn.hidden = !this.hasCamera()
  }

  /** 手动模式横幅：明确告诉用户表情识别没开，并给一条回到正常路径的出口。 */
  showManualBanner(on: boolean): void {
    this.banner.hidden = !on
    this.setReconnecting(false)
  }

  setReconnecting(on: boolean): void {
    this.bannerBtn.disabled = on
    this.bannerBtn.textContent = on ? copy.manual.connecting : copy.manual.reconnect
  }

  private hasCamera(): boolean {
    return !!this.video.srcObject
  }

  /** 合成当前画面：video 按 CSS 同样做 scaleX(-1)，再叠粒子 canvas。 */
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
    if (this.sharing || !this.hasCamera()) return
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
        // 用户自己在系统面板里取消了，不是错误，也不该弹提示
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
    // 引导还在说话时才给「跳过」；只剩进度条时没有东西可跳
    this.guideRow.hidden = text === ''
    if (text !== '' && this.guideText.textContent !== text) this.guideText.textContent = text
    this.guideBar.hidden = false
    this.guideBar.dataset.phase = phase
    this.guideFill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`
  }

  // ---------- 一次性提示 ----------

  private toastTimer = 0

  toast(text: string): void {
    this.toastEl.hidden = false
    this.toastEl.textContent = text
    this.toastEl.classList.add('is-on')
    if (this.toastTimer) window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('is-on')
      this.toastTimer = window.setTimeout(() => {
        this.toastEl.hidden = true
      }, 300)
    }, 1800)
  }

  /** 长时间没人 → 停掉检测和渲染。整块可点，点哪儿都能继续。 */
  showPaused(on: boolean): void {
    this.pausedEl.hidden = !on
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

  /** 「去设置里允许」这句话在每个平台指向不同的地方，说不清路径用户就放弃了。 */
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

  showError(kind: 'denied' | 'unsupported' | 'timeout' | 'modelFail'): void {
    const map = {
      denied: [copy.error.denied, copy.error.deniedHint],
      unsupported: [copy.error.unsupported, copy.error.unsupportedHint],
      timeout: [copy.error.timeout, copy.error.timeoutHint],
      modelFail: [copy.error.modelFail, copy.error.modelFailHint],
    } as const
    const [title, hint] = map[kind]
    const steps = kind === 'denied' ? `<p class="error-steps">${this.deniedSteps()}</p>` : ''
    this.errorPage.hidden = false
    this.errorPage.innerHTML = `
      <div class="error-inner">
        <h2>${title}</h2>
        ${steps}
        <p>${hint}</p>
        <div class="error-actions">
          <button class="btn-ghost" id="errRetry">${copy.error.retry}</button>
          <button class="btn-primary" id="errFallback">${copy.error.fallback}</button>
        </div>
      </div>`
    // 重试不刷新页面：刷新会把模型重新下一遍，国内网络下等于把用户再关十几秒。
    this.errorPage.querySelector('#errRetry')?.addEventListener('click', () => {
      this.errorPage.hidden = true
      this.cb.onReconnect()
    })
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
