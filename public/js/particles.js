// Canvas 粒子：欢迎页（ambient：logo 周围一圈绕着转的彩色光点）、
// AI 思考中还没吐字时的占位（thinking：一小段成员色的粒子流）。不依赖其他模块。
//
// mountParticles(el, { mode: 'ambient' | 'thinking' }) → { stop() }
// - 系统设置了「减少动态效果」就不画（el 上不会出现 particles-on，界面自己显示静态的替代）
// - 窗口不在前台、页面隐藏、元素不在可见区域时暂停；元素从页面上移除后自己停掉

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const live = new Set();
let focused = document.hasFocus();
const kickAll = () => { for (const p of live) p.kick(); };
window.addEventListener('focus', () => { focused = true; kickAll(); });
window.addEventListener('blur', () => { focused = false; });
document.addEventListener('visibilitychange', kickAll);
reduced.addEventListener?.('change', () => { for (const p of [...live]) if (reduced.matches) p.stop(); });

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // 约 -1..1，中间多
const ease = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

/// 欢迎页：logo 周围一圈慢慢绕着转的光点，薄荷绿为主，夹着粉色和奶黄（logo 的颜色）
function ambientParticles(w, h) {
  const R = Math.min(w, h) * 0.36;
  const tones = ['mint', 'mint', 'mint', 'mint', 'pink', 'pink', 'butter'];
  const halo = Array.from({ length: Math.round(R * 3.2) }, () => ({
    a: rand(0, TAU), r: R * (1 + gauss() * 0.22), speed: rand(0.05, 0.16) * (Math.random() < 0.82 ? 1 : -1),
    wob: rand(0.4, 1.4), phase: rand(0, TAU), size: rand(0.7, 1.9), alpha: rand(0.35, 0.95),
    tone: tones[Math.floor(Math.random() * tones.length)], tw: rand(0.6, 1.8),
  }));
  const dust = Array.from({ length: 40 }, () => ({
    x: rand(0, w), y: rand(0, h), vx: rand(-4, 4), vy: rand(-3, 3), size: rand(0.5, 1.1), alpha: rand(0.08, 0.22),
  }));
  // 起点散开，进场时聚拢
  for (const p of halo) { p.sx = rand(0, w); p.sy = rand(0, h); }
  return { R, halo, dust };
}

function drawAmbient(ctx, w, h, t, s, col, pointer) {
  const cx = w / 2;
  const cy = h / 2;
  const { R } = s;
  const gather = ease(t / 1.8);
  const push = (x, y) => {
    if (!pointer) return [x, y];
    const dx = x - pointer.x;
    const dy = y - pointer.y;
    const d2 = dx * dx + dy * dy;
    const reach = R * 0.5;
    if (d2 > reach * reach || d2 < 0.01) return [x, y];
    const d = Math.sqrt(d2);
    const k = (1 - d / reach) ** 2 * R * 0.18;
    return [x + (dx / d) * k, y + (dy / d) * k];
  };
  for (const p of s.dust) {
    p.x = (p.x + p.vx / 60 + w) % w;
    p.y = (p.y + p.vy / 60 + h) % h;
    ctx.globalAlpha = p.alpha * gather;
    ctx.fillStyle = col.mint;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }
  for (const p of s.halo) {
    const a = p.a + t * p.speed;
    const r = p.r + Math.sin(t * p.wob + p.phase) * R * 0.05;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.92;
    const [px, py] = push(p.sx + (x - p.sx) * gather, p.sy + (y - p.sy) * gather);
    ctx.globalAlpha = p.alpha * (0.65 + 0.35 * Math.sin(t * p.tw + p.phase));
    ctx.fillStyle = col[p.tone];
    ctx.beginPath();
    ctx.arc(px, py, p.size, 0, TAU);
    ctx.fill();
  }
}

function thinkingParticles(w, h) {
  return {
    dots: Array.from({ length: Math.max(16, Math.round(w / 3.2)) }, () => ({
      x: rand(0, w), speed: rand(10, 26), phase: rand(0, TAU), amp: rand(0.15, 0.4) * h, size: rand(0.7, 1.5), alpha: rand(0.35, 1),
    })),
  };
}

function drawThinking(ctx, w, h, t, s, col) {
  ctx.fillStyle = col.member;
  for (const p of s.dots) {
    const x = (p.x + t * p.speed) % w;
    const env = Math.sin((x / w) * Math.PI); // 两头淡出
    const y = h / 2 + Math.sin(x * 0.09 - t * 2.2 + p.phase) * p.amp * env;
    ctx.globalAlpha = p.alpha * env;
    ctx.beginPath();
    ctx.arc(x, y, p.size, 0, TAU);
    ctx.fill();
  }
}

export function mountParticles(el, { mode = 'ambient' } = {}) {
  if (reduced.matches || !el) return { stop() {} };
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  el.appendChild(canvas);
  el.classList.add('particles-on');
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let scene = null;
  let raf = 0;
  let stopped = false;
  let visible = true;
  let clock = 0;          // 只在动的时候走，暂停回来接着上次
  let last = 0;
  let col = null;
  let colAt = -1;
  let pointer = null;

  const readColors = () => {
    const cs = getComputedStyle(el);
    col = {
      mint: cs.getPropertyValue('--brand-text').trim() || '#7BDDC2',
      pink: cs.getPropertyValue('--signal-dot').trim() || '#F5A1C7',
      butter: cs.getPropertyValue('--warn').trim() || '#F6D77A',
      member: cs.getPropertyValue('--c').trim() || cs.getPropertyValue('--muted').trim() || '#888',
    };
  };
  const draw = () => {
    if (!w || !h) return;
    if (clock - colAt > 1 || colAt < 0) { readColors(); colAt = clock; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dpr = canvas.width / w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (mode === 'thinking') drawThinking(ctx, w, h, clock, scene, col);
    else drawAmbient(ctx, w, h, clock, scene, col, pointer);
    ctx.globalAlpha = 1;
  };
  const running = () => !stopped && visible && focused && !document.hidden;
  const frame = (now) => {
    raf = 0;
    if (!el.isConnected) { handle.stop(); return; }
    if (!running()) { last = 0; return; }
    if (last) clock += Math.min(0.05, (now - last) / 1000);
    last = now;
    draw();
    raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (!raf && running()) raf = requestAnimationFrame(frame); };
  const resize = () => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (Math.round(r.width) === w && Math.round(r.height) === h && canvas.width === Math.round(w * dpr)) return;
    w = Math.round(r.width);
    h = Math.round(r.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    scene = mode === 'thinking' ? thinkingParticles(w, h) : ambientParticles(w, h);
    // 改尺寸、或者一打开就在后台（这时只画一帧）：直接是聚好的样子，不演聚拢
    if (mode !== 'thinking' && (clock > 0 || !running())) clock = Math.max(clock, 1.8);
    draw(); // 暂停时也画一帧，不留空白
    kick();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); });
  io.observe(el);
  const onMove = (e) => { const r = canvas.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onLeave = () => { pointer = null; };
  if (mode === 'ambient') { el.addEventListener('pointermove', onMove); el.addEventListener('pointerleave', onLeave); }

  const handle = {
    kick,
    stop() {
      if (stopped) return;
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      canvas.remove();
      el.classList.remove('particles-on');
      live.delete(handle);
    },
  };
  live.add(handle);
  return handle;
}
