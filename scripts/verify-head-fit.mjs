// 头部碰撞体的数值验证。跑法：npm run verify:head
//
// 为什么需要它：椭圆拟合和滤波都是「看起来对」但很难用眼睛验收的数学。
// 对着摄像头目测只能看出「大概跟着头走」，看不出角度差了 3 度、
// 或者椭圆在某个方向漏包了轮廓。这个脚本用合成的「歪着的脸」把三件事量化：
//   1. PCA 能不能从整圈轮廓还原出头部朝向，误差多少度
//   2. 补上颅顶、上移中心之后，椭圆是不是真的把整圈轮廓包住了
//   3. One Euro 滤波静止时压掉多少抖动、运动时引入多少滞后
//
// 常量必须与 src/face.ts 保持一致；改了那边记得改这里，再跑一次。
const SKULL_EXTEND = 0.3, HAIR_WIDEN = 1.06, FIT_MARGIN = 1.02, N = 36

function fit(ox, oy, topX, topY, chinX, chinY) {
  let mx = 0, my = 0
  for (let i = 0; i < N; i++) { mx += ox[i]; my += oy[i] }
  mx /= N; my /= N
  let sxx = 0, syy = 0, sxy = 0
  for (let i = 0; i < N; i++) {
    const dx = ox[i] - mx, dy = oy[i] - my
    sxx += dx*dx; syy += dy*dy; sxy += dx*dy
  }
  let major = 0.5 * Math.atan2(2*sxy, sxx - syy)
  const upRefX = topX - chinX, upRefY = topY - chinY
  if (Math.cos(major)*upRefX + Math.sin(major)*upRefY < 0) major += Math.PI
  const upX = Math.cos(major), upY = Math.sin(major)
  const rightX = -upY, rightY = upX
  let halfUp = 0, halfRight = 0
  for (let i = 0; i < N; i++) {
    const dx = ox[i]-mx, dy = oy[i]-my
    const pu = Math.abs(dx*upX + dy*upY), pr = Math.abs(dx*rightX + dy*rightY)
    if (pu > halfUp) halfUp = pu
    if (pr > halfRight) halfRight = pr
  }
  const grow = SKULL_EXTEND * halfUp
  const cx = mx + upX*(grow/2), cy = my + upY*(grow/2)
  const ry = (halfUp + grow/2)*FIT_MARGIN, rx = halfRight*HAIR_WIDEN
  let rot = Math.atan2(rightY, rightX)
  while (rot >  Math.PI/2) rot -= Math.PI
  while (rot <= -Math.PI/2) rot += Math.PI
  return { cx, cy, rx, ry, rot, mx, my, upX, upY }
}

function makeFace(phi, a = 40, b = 55, cx = 300, cy = 400, noise = 0) {
  const up = [Math.sin(phi), -Math.cos(phi)]
  const right = [Math.cos(phi), Math.sin(phi)]
  const ox = new Float64Array(N), oy = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2
    const jx = (Math.random()-0.5)*noise, jy = (Math.random()-0.5)*noise
    ox[i] = cx + right[0]*a*Math.cos(t) + up[0]*b*Math.sin(t) + jx
    oy[i] = cy + right[1]*a*Math.cos(t) + up[1]*b*Math.sin(t) + jy
  }
  return { ox, oy, up, topX: cx+up[0]*b, topY: cy+up[1]*b, chinX: cx-up[0]*b, chinY: cy-up[1]*b, cx, cy }
}

let fail = 0
for (const [deg, noise] of [[0,0],[25,0],[-40,0],[0,1.2],[12,1.2],[-12,1.2],[25,1.2],[-25,1.2],[40,1.2],[-40,1.2],[60,1.2],[-60,1.2]]) {
  const phi = deg*Math.PI/180
  const f = makeFace(phi, 40, 55, 300, 400, noise)
  const r = fit(f.ox, f.oy, f.topX, f.topY, f.chinX, f.chinY)
  const gotDeg = r.rot*180/Math.PI
  const angErr = Math.abs(gotDeg - deg)

  // 1) 角度还原
  const okAng = angErr < 2.5
  // 2) 整圈轮廓被包住
  const c = Math.cos(r.rot), s = Math.sin(r.rot)
  let maxD = 0
  for (let i = 0; i < N; i++) {
    const dx = f.ox[i]-r.cx, dy = f.oy[i]-r.cy
    const lx = dx*c + dy*s, ly = -dx*s + dy*c
    const d = (lx/r.rx)**2 + (ly/r.ry)**2
    if (d > maxD) maxD = d
  }
  // 无噪声时必须严格包住；有噪声时允许单点略微越界（噪声本身就在轮廓外）
  const okContain = maxD <= (noise ? 1.06 : 1.0)
  // 3) 中心朝头顶上移
  const moved = (r.cx-r.mx)*f.up[0] + (r.cy-r.my)*f.up[1]
  const okUp = moved > 0
  // 4) 高度确实变高了（覆盖颅顶）
  const okTaller = r.ry > 55*1.1

  const ok = okAng && okContain && okUp && okTaller
  if (!ok) fail++
  console.log(
    `tilt ${String(deg).padStart(4)}° 噪声${noise ? '±0.6px' : '  无  '}  →  rot ${gotDeg.toFixed(1).padStart(6)}°  ` +
    `误差 ${angErr.toFixed(2)}°  包围 ${maxD.toFixed(3)}  上移 ${moved.toFixed(1)}px  ` +
    `ry ${r.ry.toFixed(1)}(原 55)  ${ok ? 'PASS' : 'FAIL'}`)
}

// One Euro：静止时抖动应被大幅压制，运动时不应严重滞后
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) { this.mc = minCutoff; this.b = beta; this.dc = dCutoff; this.x = NaN; this.dx = 0 }
  static a(cut, dt) { const tau = 1/(2*Math.PI*cut); return 1/(1+tau/dt) }
  filter(x, dt) {
    if (!Number.isFinite(this.x) || dt <= 0) { this.x = x; this.dx = 0; return x }
    const d = (x-this.x)/dt, aD = OneEuro.a(this.dc, dt)
    this.dx = aD*d + (1-aD)*this.dx
    const a = OneEuro.a(this.mc + this.b*Math.abs(this.dx), dt)
    this.x = a*x + (1-a)*this.x
    return this.x
  }
}
const dt = 1/20
// 静止 + ±1.5px 抖动
let f1 = new OneEuro(1.2, 0.015), inAmp = 0, outAmp = 0, prevIn = 300, prevOut = 300
for (let i = 0; i < 200; i++) {
  const raw = 300 + (Math.random()-0.5)*3
  const out = f1.filter(raw, dt)
  if (i > 20) { inAmp += Math.abs(raw-prevIn); outAmp += Math.abs(out-prevOut) }
  prevIn = raw; prevOut = out
}
console.log(`\n静止抖动：输入逐帧变化合计 ${inAmp.toFixed(0)}px → 输出 ${outAmp.toFixed(0)}px（压制到 ${(outAmp/inAmp*100).toFixed(0)}%）`)
// 匀速运动 400px/s，看稳态滞后
let f2 = new OneEuro(1.2, 0.015), pos = 300, lag = 0
for (let i = 0; i < 80; i++) { pos += 400*dt; lag = pos - f2.filter(pos, dt) }
console.log(`匀速 400px/s 时稳态滞后 ${lag.toFixed(1)}px（约 ${(lag/400*1000).toFixed(0)}ms）`)
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
