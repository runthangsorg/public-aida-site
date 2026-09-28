// A few dozen gold motes drifting up through her aura. Canvas 2D, transform-
// free, cleared and redrawn each frame; it stops when the tab is hidden and
// never starts under prefers-reduced-motion.

interface Mote {
  x: number;
  y: number;
  r: number;
  rise: number;
  sway: number;
  phase: number;
  alpha: number;
}

const COUNT = 36;

function seed(m: Mote, fresh: boolean): void {
  m.x = 0.1 + Math.random() * 0.8;
  m.y = fresh ? Math.random() : 1.04;
  m.r = 0.6 + Math.random() * 1.5;
  m.rise = 0.035 + Math.random() * 0.045;
  m.sway = 0.6 + Math.random() * 0.8;
  m.phase = Math.random() * Math.PI * 2;
  m.alpha = 0.18 + Math.random() * 0.42;
}

export function startMotes(canvas: HTMLCanvasElement, intensity: () => number): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => undefined;

  const motes: Mote[] = [];
  for (let i = 0; i < COUNT; i++) {
    const m: Mote = { x: 0, y: 0, r: 0, rise: 0, sway: 0, phase: 0, alpha: 0 };
    seed(m, true);
    motes.push(m);
  }

  let w = 0;
  let h = 0;
  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  let raf = 0;
  let last = 0;

  const frame = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const talk = intensity();
    ctx.clearRect(0, 0, w, h);
    for (const m of motes) {
      m.y -= m.rise * dt;
      m.phase += m.sway * dt;
      if (m.y < -0.04) seed(m, false);
      const x = (m.x + Math.sin(m.phase) * 0.015) * w;
      const y = m.y * h;
      // Brightest near her, fading towards the edges of the box.
      const dx = m.x - 0.5;
      const dy = m.y - 0.45;
      const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 1.9);
      const a = m.alpha * near * (0.55 + talk * 0.6);
      if (a <= 0.005) continue;
      ctx.beginPath();
      ctx.arc(x, y, m.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(245, 190, 96, ${a.toFixed(3)})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  };

  const start = (): void => {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  const stop = (): void => {
    cancelAnimationFrame(raf);
    raf = 0;
  };

  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener("visibilitychange", onVisibility);
  start();

  return () => {
    stop();
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
