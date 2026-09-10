// 摄像头：只负责拿到一路 640×480 的前置视频流。
// 镜像交给 CSS（见 style.css 的 #cam），face.ts 里把坐标做同样的镜像换算。

export type CameraError = 'denied' | 'unsupported' | 'timeout' | 'unknown'

export class CameraError_ extends Error {
  constructor(public kind: CameraError) {
    super(kind)
  }
}

/**
 * 授权弹窗可能既不被允许也不被拒绝——用户切走了、弹窗被挡住了、系统层面吞掉了。
 * 这种情况下 getUserMedia 永远不返回，界面会一直停在加载态，看起来像挂了。
 * 所以必须有超时。
 */
const PERMISSION_TIMEOUT_MS = 10_000

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError_('unsupported')
  }
  let stream: MediaStream
  try {
    stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new CameraError_('timeout')), PERMISSION_TIMEOUT_MS),
      ),
    ])
  } catch (e) {
    if (e instanceof CameraError_) throw e
    const name = (e as DOMException)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError_('denied')
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      throw new CameraError_('unsupported')
    throw new CameraError_('unknown')
  }

  video.srcObject = stream
  video.playsInline = true
  video.muted = true
  await video.play().catch(() => {
    /* iOS 偶尔在首帧前 reject，后续 loadeddata 会补上 */
  })
  await waitForFrame(video)
  return stream
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('loadeddata', done)
      resolve()
    }
    video.addEventListener('loadeddata', done)
    setTimeout(done, 4000) // 兜底，绝不无限等
  })
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop())
}
