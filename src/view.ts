// 视频 → 屏幕的坐标映射。
//
// <video> 用 object-fit: cover 铺满屏幕，再用 scaleX(-1) 镜像。
// 640×480 的画面放到 390×844 的竖屏上，会按高度放大 1.76 倍、左右各裁掉约 370px。
// 早期版本把归一化坐标直接乘屏幕宽高（x_px = (1 - x) * w），在桌面上（比例接近）看不出问题，
// 在手机上头部碰撞体会被横向压扁——这是「碰撞不准」的来源之一。

export interface CoverMap {
  scale: number
  offX: number
  offY: number
}

export function coverMap(vw: number, vh: number, w: number, h: number, out: CoverMap): CoverMap {
  const scale = Math.max(w / vw, h / vh)
  out.scale = scale
  out.offX = (w - vw * scale) / 2
  out.offY = (h - vh * scale) / 2
  return out
}

/** 视频像素 (vx, vy) → 屏幕像素，含镜像 */
export function videoToScreenX(vx: number, m: CoverMap, w: number): number {
  return w - (vx * m.scale + m.offX)
}
export function videoToScreenY(vy: number, m: CoverMap): number {
  return vy * m.scale + m.offY
}
/** 屏幕像素 → 视频像素，含镜像 */
export function screenToVideoX(sx: number, m: CoverMap, w: number): number {
  return (w - sx - m.offX) / m.scale
}
export function screenToVideoY(sy: number, m: CoverMap): number {
  return (sy - m.offY) / m.scale
}
