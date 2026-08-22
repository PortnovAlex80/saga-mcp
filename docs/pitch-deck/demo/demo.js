/* ============================================================================
   SAGA · ЗАВОД ИЗНУТРИ — кинематографичное демо конвейера
   Один файл, без зависимостей. Матрёшка: ЗАВОД → ЦЕХ → РАБОЧИЙ СТОЛ.
   Вся терминология кадров — реальный словарь завода (CONVEYOR-MENTAL-MODEL §28):
   Workplace, CandidateSet, GateDecision, RecoveryIssue, ReplayCapsule, EffectReceipt.
   ============================================================================ */
'use strict';
/* отладка: показываем упавшие ошибки прямо на странице */
window.addEventListener('error', e => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);z-index:99;background:#1a0000;color:#FF5D6C;font:13px Consolas,monospace;max-width:92%;padding:16px 20px;border:2px solid #FF5D6C;white-space:pre-wrap';
  d.textContent = 'ERR: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno;
  document.body.appendChild(d);
});

/* ------------------------------- utils ---------------------------------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, k) => a + (b - a) * k;
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const eio = k => k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const eo = k => 1 - Math.pow(1 - k, 3);
function sr(seed) { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => (s = s * 16807 % 2147483647 - 1) / 2147483646; }
const P = { // палитра питч-дека
  bg: '#0A0F1E', panel: '#141E38', panel2: '#12192E', line: '#2A3B66', line2: '#33436E',
  ink: '#F4F7FF', mut: '#93A5CE', dim: '#66799F', amb: '#FFB020', amb2: '#FFD97A',
  grn: '#3DDC97', red: '#FF5D6C', cyan: '#6FD3E8'
};

/* ------------------------------- canvas --------------------------------- */
const cv = document.getElementById('stage');
const cx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1, BASE = 1, OX = 0, OY = 0, vign = null;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  BASE = Math.min(W / 1600, H / 900);
  OX = W / 2; OY = H / 2;
  vign = cx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .38, W / 2, H / 2, Math.max(W, H) * .72);
  vign.addColorStop(0, 'rgba(0,0,0,0)'); vign.addColorStop(1, 'rgba(2,5,14,.55)');
}
window.addEventListener('resize', resize); resize();

function rr(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function txt(c, s, x, y, o = {}) {
  c.save();
  c.font = `${o.w || 400} ${o.s || 12}px ${o.m ? 'Consolas' : "'Segoe UI'"}, Arial, sans-serif`;
  c.textAlign = o.a || 'left'; c.textBaseline = o.b || 'alphabetic';
  c.fillStyle = o.c || P.mut;
  try { if (o.ls) c.letterSpacing = o.ls + 'px'; } catch (e) { }
  if (o.g) { c.shadowColor = o.g; c.shadowBlur = o.gb || 14; }
  c.fillText(s, x, y); c.restore();
}
function radial(c, x, y, r, col, a0, a1) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, col.replace('$', a0)); g.addColorStop(1, col.replace('$', a1));
  return g;
}

/* --------------------------- HUD / оверлеи ------------------------------- */
const $ = id => document.getElementById(id);
const capEl = $('cap'), capK = $('cap-k'), capT = $('cap-t'), cardEl = $('card'), logEl = $('log');
function caption(k, t) {
  if (!k) { capEl.classList.remove('show'); return; }
  capK.textContent = k; capT.textContent = t; capEl.classList.add('show');
}
function card(html) { if (!html) { cardEl.classList.remove('show'); return; } cardEl.innerHTML = html; cardEl.classList.add('show'); }
function log(html, cls) {
  const d = document.createElement('div'); if (cls) d.className = cls; d.innerHTML = html;
  logEl.appendChild(d); while (logEl.children.length > 5) logEl.removeChild(logEl.firstChild);
}
const ACTS = [[0, 'АКТ 1 · ЗАВОД'], [16, 'АКТ 2 · КОНСТРУКТОРСКОЕ БЮРО'], [37, 'АКТ 3 · РАБОЧИЙ СТОЛ'], [70, 'АКТ 4 · РОЙ · REPLAY · ОТГРУЗКА']];
function hudActs(T) {
  let ai = 0; for (let i = 0; i < ACTS.length; i++) if (T >= ACTS[i][0]) ai = i;
  const el = $('acts'); const want = ACTS.map((a, i) => `<span class="${i === ai ? 'on' : ''}">${a[1]}</span>`).join('');
  if (el.dataset.a !== String(ai)) { el.innerHTML = want; el.dataset.a = String(ai); }
}
function hudLevels(v, free, active) {
  const on = free ? active : (v > 1.9 ? 2 : v > 1.0 ? 1 : 0);
  document.querySelectorAll('#levels .lv').forEach((e, i) => e.classList.toggle('on', i === on));
}
let badgeCache = '';
function hudBadges(T, replay) {
  const b = [`<div class="badge">run A · factory.sqlite</div>`];
  if (T >= 40 && T < 70) b.push(`<div class="badge hot">worker: GLM-5.3 · effort max</div>`);
  if (T >= 53 && T < 59) b.push(`<div class="badge red">repair ×1 · RecoveryIssue#12</div>`);
  if (replay) b.push(`<div class="badge hot">RUN B · REPLAY ×4</div>`);
  const s = b.join(''); if (s !== badgeCache) { $('badges').innerHTML = s; badgeCache = s; }
}

/* ============================== СЦЕНА: ЗАВОД ============================== */
const Factory = {
  cam: { x: 800, y: 450, z: 1 },
  stars: (() => { const r = sr(7), a = []; for (let i = 0; i < 130; i++) a.push([r() * 1700 - 50, r() * 420, r() * 1.4 + .4, r() * TAU]); return a; })(),
  smoke: [], // {x,y,r,a,vx,vy}
  buildings: [
    { id: 'dis', label: 'DISCOVERY', x: 190, w: 170, h: 150, t0: 8.5, t1: 10 },
    { id: 'for', label: 'FORMALIZATION', x: 430, w: 220, h: 190, t0: 9.5, t1: 11 },
    { id: 'dev', label: 'DEVELOPMENT', x: 760, w: 380, h: 210, t0: 10.5, t1: 12.5 },
    { id: 'del', label: 'DELIVERY', x: 1290, w: 200, h: 140, t0: 11.5, t1: 13.5 },
  ],
  lit(T, b) { return this.cin(T) ? sm(b.t0, b.t1, T) : 1; },
  cin(T) { return Director.mode === 'cine'; },
  update(dt, T) {
    // дым труб
    if (Math.random() < .12 && this.smoke.length < 40) this.smoke.push({ x: 1148 + Math.random() * 20, y: 300, r: 6, a: .16, vx: 14 + Math.random() * 10, vy: -12 - Math.random() * 8 });
    for (const s of this.smoke) { s.x += s.vx * dt; s.y += s.vy * dt; s.r += 9 * dt; s.a -= .055 * dt; }
    this.smoke = this.smoke.filter(s => s.a > 0);
  },
  // капсула-заказ: путь ворота → диспетчер (за 5с от t0)
  courierK(T) { return clamp((T - 2.2) / 5, 0, 1); },
  beltSpeed(T) { return this.cin(T) ? 40 + 140 * sm(11, 13.2, T) : 150; },

  draw(c, T, alpha) {
    c.save(); c.globalAlpha = alpha;
    // небо
    const sky = c.createLinearGradient(0, -100, 0, 620);
    sky.addColorStop(0, '#070B18'); sky.addColorStop(.75, '#0C1428'); sky.addColorStop(1, '#101B36');
    c.fillStyle = sky; c.fillRect(-400, -300, 2400, 940);
    // звёзды и луна
    for (const [x, y, r, ph] of this.stars) {
      c.globalAlpha = alpha * (.25 + .45 * Math.abs(Math.sin(T * .7 + ph)));
      c.fillStyle = '#C7D3EE'; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    }
    c.globalAlpha = alpha;
    c.fillStyle = radial(c, 1400, 110, 90, 'rgba(255,236,190,$)', .5, 0); c.fillRect(1270, -30, 260, 280);
    c.fillStyle = '#F4E9C8'; c.beginPath(); c.arc(1400, 110, 26, 0, TAU); c.fill();
    c.fillStyle = '#0C1428'; c.beginPath(); c.arc(1390, 100, 22, 0, TAU); c.fill();
    // дальний план: трубы и эстакада
    c.fillStyle = '#0D1526';
    c.fillRect(1120, 240, 26, 200); c.fillRect(1168, 262, 20, 178);
    c.beginPath(); c.moveTo(1050, 470); c.lineTo(1240, 330); c.lineTo(1330, 330); c.lineTo(1560, 470); c.closePath(); c.fill();
    for (const s of this.smoke) { c.globalAlpha = alpha * s.a; c.fillStyle = '#8FA1CC'; c.beginPath(); c.arc(s.x, s.y, s.r, 0, TAU); c.fill(); }
    c.globalAlpha = alpha;
    // земля
    const gr = c.createLinearGradient(0, 560, 0, 940);
    gr.addColorStop(0, '#0C1226'); gr.addColorStop(1, '#0A0F1E');
    c.fillStyle = gr; c.fillRect(-400, 560, 2400, 400);
    c.strokeStyle = 'rgba(51,67,110,.4)'; c.lineWidth = 1;
    for (let y = 580; y < 940; y += 36) { c.beginPath(); c.moveTo(-400, y); c.lineTo(2000, y); c.stroke(); }

    // дорога заказа
    c.strokeStyle = '#1B2547'; c.lineWidth = 34; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-200, 780); c.quadraticCurveTo(120, 760, 220, 690); c.quadraticCurveTo(320, 620, 470, 636); c.stroke();
    c.strokeStyle = 'rgba(147,165,206,.25)'; c.lineWidth = 2; c.setLineDash([14, 18]); c.lineDashOffset = -T * 30;
    c.beginPath(); c.moveTo(-200, 780); c.quadraticCurveTo(120, 760, 220, 690); c.quadraticCurveTo(320, 620, 470, 636); c.stroke();
    c.setLineDash([]);

    // главный конвейер между цехами
    this.belt(c, 340, 700, 1120, this.beltSpeed(T), T);

    // ворота завода
    this.gates(c, T);
    // здания
    for (const b of this.buildings) this.building(c, b, this.lit(T, b), T);
    this.dispatcher(c, T);
    this.waterTower(c, T);
    this.finale(c, T);
    // капсула-заказ
    const ck = this.courierK(T);
    if (ck < 1) {
      const pt = this.courierPath(ck);
      c.save(); c.translate(pt.x, pt.y);
      c.fillStyle = radial(c, 0, 0, 42, 'rgba(255,217,122,$)', .55, 0); c.fillRect(-44, -44, 88, 88);
      c.fillStyle = P.amb2; rr(c, -16, -12, 32, 24, 6); c.fill();
      c.strokeStyle = '#0A0F1E'; c.lineWidth = 2; c.beginPath(); c.moveTo(-8, 0); c.lineTo(8, 0); c.stroke();
      txt(c, 'idea', 0, 4, { s: 8, c: '#0A0F1E', w: 700, a: 'center' });
      c.restore();
    }
    c.restore();
  },
  courierPath(k) {
    const e = eio(k);
    const x = lerp(-140, 700, e), y = 780 - Math.sin(e * Math.PI) * 90 - e * 90;
    return { x, y: Math.max(y, 600) };
  },
  belt(c, x, y, w, speed, T) {
    c.fillStyle = '#10192F'; rr(c, x, y - 8, w, 16, 8); c.fill();
    c.strokeStyle = '#223052'; c.lineWidth = 2; rr(c, x, y - 8, w, 16, 8); c.stroke();
    c.strokeStyle = 'rgba(255,176,32,.55)'; c.lineWidth = 3; c.setLineDash([12, 16]); c.lineDashOffset = -speed * T;
    c.beginPath(); c.moveTo(x + 6, y); c.lineTo(x + w - 6, y); c.stroke(); c.setLineDash([]);
    // опоры
    c.fillStyle = '#0D1526';
    for (let bx = x + 40; bx < x + w - 20; bx += 120) c.fillRect(bx, y + 8, 8, 40);
  },
  gates(c, T) {
    const x = 60, y = 640;
    c.fillStyle = '#141E38'; c.fillRect(x - 8, y - 120, 20, 120); c.fillRect(x + 96, y - 120, 20, 120);
    c.fillStyle = '#1B2547'; rr(c, x - 14, y - 150, 136, 36, 6); c.fill();
    txt(c, 'SAGA', x + 54, y - 126, { s: 15, c: P.amb2, w: 800, a: 'center', ls: 5 });
    const bl = .5 + .5 * Math.sin(T * 2.4);
    c.fillStyle = `rgba(255,93,108,${.35 + .5 * bl})`; c.beginPath(); c.arc(x + 54, y - 156, 4, 0, TAU); c.fill();
  },
  building(c, b, lit, T) {
    const y = 560 - b.h;
    c.fillStyle = '#101A31'; c.fillRect(b.x, y, b.w, b.h);
    c.strokeStyle = '#223052'; c.lineWidth = 2; c.strokeRect(b.x, y, b.w, b.h);
    // крыша
    c.fillStyle = '#0D1526';
    if (b.id === 'dev') { // пильная крыша главного цеха
      c.beginPath(); c.moveTo(b.x, y);
      for (let i = 0; i < 4; i++) { c.lineTo(b.x + 20 + i * 95, y - 44); c.lineTo(b.x + 72 + i * 95, y - 44); c.lineTo(b.x + 95 + i * 95, y); }
      c.closePath(); c.fill(); c.stroke();
    } else { c.fillRect(b.x - 6, y - 14, b.w + 12, 14); c.strokeRect(b.x - 6, y - 14, b.w + 12, 14); }
    // окна
    const cols = b.id === 'dev' ? 10 : b.id === 'for' ? 6 : 4, rows = b.id === 'dev' ? 2 : b.id === 'for' ? 3 : 2;
    const ww = 18, wh = 16;
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const wx = b.x + 14 + q * ((b.w - 28 - ww) / (cols - 1)), wy = y + 18 + r * (b.h - 40) / (rows - 1 || 1);
      const flick = Math.sin(T * 3 + q * 7.3 + r * 3.1 + b.x) * .5 + .5;
      const on = (q + r * cols) / (cols * rows) < lit - .001;
      if (on) {
        c.fillStyle = `rgba(255,176,32,${.5 + .4 * flick})`; c.fillRect(wx, wy, ww, wh);
        c.fillStyle = radial(c, wx + ww / 2, wy + wh / 2, 26, 'rgba(255,176,32,$)', .18 * lit, 0); c.fillRect(wx - 26, wy - 26, ww + 52, wh + 52);
      } else { c.fillStyle = '#0B1122'; c.fillRect(wx, wy, ww, wh); }
      c.strokeStyle = '#1B2547'; c.lineWidth = 1; c.strokeRect(wx, wy, ww, wh);
    }
    // круглое окно КБ — цель погружения
    if (b.id === 'for') {
      const g = 55 * lit;
      c.fillStyle = radial(c, b.x + b.w / 2, y + 46, 40, 'rgba(255,217,122,$)', .5 * lit, 0); c.fillRect(b.x + b.w / 2 - 44, y, 88, 96);
      c.strokeStyle = P.amb; c.lineWidth = 3; c.beginPath(); c.arc(b.x + b.w / 2, y + 46, 26, 0, TAU); c.stroke();
      c.strokeStyle = `rgba(255,217,122,${.25 + g / 200})`; c.lineWidth = 5;
      c.beginPath(); c.arc(b.x + b.w / 2, y + 46, 34 + Math.sin(T * 2) * 3, 0, TAU); c.stroke();
    }
    if (b.id === 'dev') { // вывеска цеха
      c.fillStyle = 'rgba(20,30,56,.9)'; rr(c, b.x + b.w / 2 - 118, y + b.h + 14, 236, 30, 6); c.fill();
      c.strokeStyle = '#33436E'; c.stroke();
      txt(c, 'ЦЕХ · ПРОИЗВОДСТВЕННЫЕ ЯЧЕЙКИ', b.x + b.w / 2, y + b.h + 34, { s: 11, c: P.amb2, w: 700, a: 'center', ls: 2 });
    }
    txt(c, b.label, b.x + b.w / 2, y - 22, { s: 12, c: P.dim, w: 700, a: 'center', ls: 3 });
  },
  dispatcher(c, T) {
    const x = 700, y = 560;
    c.strokeStyle = '#2A3B66'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(x - 14, y); c.lineTo(x, y - 190); c.lineTo(x + 14, y); c.moveTo(x - 8, y - 120); c.lineTo(x + 8, y - 120); c.moveTo(x - 10, y - 60); c.lineTo(x + 10, y - 60); c.stroke();
    // радар
    const a = T * 1.6;
    c.save(); c.translate(x, y - 200);
    c.strokeStyle = '#33436E'; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 26, 0, TAU); c.stroke();
    const beam = c.createLinearGradient(0, 0, 90 * Math.cos(a), 90 * Math.sin(a));
    beam.addColorStop(0, 'rgba(255,176,32,.8)'); beam.addColorStop(1, 'rgba(255,176,32,0)');
    c.strokeStyle = beam; c.lineWidth = 3; c.beginPath(); c.moveTo(0, 0); c.lineTo(86 * Math.cos(a), 86 * Math.sin(a)); c.stroke();
    c.fillStyle = `rgba(255,93,108,${.4 + .4 * Math.sin(T * 4)})`; c.beginPath(); c.arc(0, 0, 5, 0, TAU); c.fill();
    c.restore();
    txt(c, 'DISPATCH', x, y + 24, { s: 11, c: P.dim, w: 700, a: 'center', ls: 2 });
  },
  waterTower(c, T) {
    const x = 1200, y = 560;
    c.strokeStyle = '#223052'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(x - 26, y); c.lineTo(x - 16, y - 110); c.moveTo(x + 26, y); c.lineTo(x + 16, y - 110); c.stroke();
    c.fillStyle = '#141E38'; rr(c, x - 40, y - 170, 80, 64, 10); c.fill(); c.strokeStyle = '#2A3B66'; c.stroke();
    txt(c, 'SQLite', x, y - 132, { s: 11, c: P.mut, m: 1, a: 'center' });
    // труба данных к цеху: пульс пакетов
    c.strokeStyle = '#1B2547'; c.lineWidth = 4; c.beginPath(); c.moveTo(x - 30, y - 140); c.quadraticCurveTo(1080, y - 200, 1020, y - 40); c.stroke();
    for (let i = 0; i < 3; i++) {
      const k = ((T * .35 + i / 3) % 1);
      const px = lerp(x - 30, 1020, k), py = y - 140 + Math.sin(k * Math.PI) * -60 + k * 100;
      c.fillStyle = `rgba(111,211,232,${.7 - .4 * k})`; c.beginPath(); c.arc(px, py, 3, 0, TAU); c.fill();
    }
  },
  finale(c, T) {
    if (Director.mode !== 'cine' || T < 86.5) return;
    const k = sm(87, 90.5, T), out = sm(89.5, 94, T);
    const b = this.buildings[3];
    const y = 560;
    // дверь открывается
    c.fillStyle = '#0B1122'; c.fillRect(b.x + 60, y - 74, 80 * k, 74);
    c.strokeStyle = P.amb; c.lineWidth = 2; c.strokeRect(b.x + 60, y - 74, 80, 74);
    if (out > 0) {
      const x = lerp(b.x + 100, 140, eo(out));
      c.save(); c.translate(x, y - 8);
      c.fillStyle = radial(c, 0, 0, 70, 'rgba(61,220,151,$)', .3, 0); c.fillRect(-70, -70, 140, 140);
      c.fillStyle = '#141E38'; rr(c, -34, -46, 68, 44, 6); c.fill(); c.strokeStyle = P.grn; c.lineWidth = 2; c.stroke();
      c.fillStyle = 'rgba(61,220,151,.16)'; rr(c, -28, -40, 56, 20, 4); c.fill();
      txt(c, 'v1.0', 0, -25, { s: 10, c: P.grn, m: 1, a: 'center' });
      c.fillStyle = '#0D1526'; c.fillRect(-24, 12, 48, 14);
      c.beginPath(); c.arc(-14, 28, 7, 0, TAU); c.arc(14, 28, 7, 0, TAU); c.fillStyle = '#1B2547'; c.fill();
      // флажок
      c.strokeStyle = '#93A5CE'; c.lineWidth = 2; c.beginPath(); c.moveTo(30, -46); c.lineTo(30, -78); c.stroke();
      c.fillStyle = P.amb; c.beginPath(); c.moveTo(30, -78); c.lineTo(86, -70); c.lineTo(30, -60); c.fill();
      txt(c, 'READY-TO-RUN', 34, -68, { s: 8, c: '#0A0F1E', w: 800 });
      c.restore();
    }
  }
};

/* =============================== СЦЕНА: ЦЕХ =============================== */
const Workshop = {
  cam: { x: 800, y: 462, z: 1.05 },
  mode: 'formalization', // formalization | development
  replay: false,
  kanban: null,
  sparks: [],
  merges: 0,
  init() {
    const r = sr(31);
    this.kanban = [];
    for (let i = 0; i < 6; i++) this.kanban.push({ seed: r() * 100, col: i < 2 ? 0 : 1, label: null });
  },
  desks() {
    if (this.mode === 'formalization')
      return [
        { id: 'A-1', part: 'PRD', kind: 'doc', x: 330, seed: 3 },
        { id: 'A-2', part: 'SRS', kind: 'doc', x: 730, seed: 11 },
        { id: 'A-3', part: 'UC/AC', kind: 'doc', x: 1090, seed: 17 },
      ];
    return [
      { id: 'DEV-1', part: 'auth.ts', kind: 'code', x: 170, seed: 3 },
      { id: 'DEV-2', part: 'api.ts', kind: 'code', x: 388, seed: 5 },
      { id: 'DEV-3', part: 'calc.ts', kind: 'code', x: 606, seed: 8 },
      { id: 'REV-1', part: 'review', kind: 'rev', x: 824, seed: 13 },
      { id: 'DEV-4', part: 'ui.ts', kind: 'code', x: 1042, seed: 21 },
      { id: 'VER-1', part: 'verify', kind: 'ver', x: 1260, seed: 25 },
    ];
  },
  // детерминированный цикл стола → {phase, k}
  deskCycle(d, t) {
    const per = 9 + (d.seed % 3), u = ((t + d.seed * 2.7) % per) / per;
    if (u < .42) return { p: 'craft', k: u / .42 };
    if (u < .55) return { p: 'send', k: (u - .42) / .13 };
    if (u < .68) return { p: 'scan', k: (u - .55) / .13 };
    const rd = ((t + d.seed * 2.7) / per);
    const red = (Math.sin(rd * 12.9898 + d.seed * 78.233) * 43758.5453 % 1 + 1) % 1 < .3;
    if (red) {
      if (u < .78) return { p: 'ret', k: (u - .68) / .10 };
      if (u < .92) return { p: 'fix', k: (u - .78) / .14 };
      return { p: 'scan2', k: (u - .92) / .08, green: true };
    }
    return { p: 'done', k: (u - .68) / .32 };
  },
  craneT(t) { return (t % 9) / 9; },
  update(dt, t) {
    if (Math.random() < .2 && this.sparks.length < 60) this.sparks.push({ x: 1290 + Math.random() * 30, y: 300, vx: (Math.random() - .5) * 120, vy: -Math.random() * 90, a: 1, g: 220 });
    for (const s of this.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 260 * dt; s.a -= 1.6 * dt; }
    this.sparks = this.sparks.filter(s => s.a > 0);
    this.merges = 1 + Math.floor(t / 9) % 5;
  },
  draw(c, t, alpha, T) {
    c.save(); c.globalAlpha = alpha;
    // пол и стены
    c.fillStyle = '#0C1428'; c.fillRect(-300, -200, 2200, 1200);
    const fl = c.createLinearGradient(0, 300, 0, 940);
    fl.addColorStop(0, '#0E1830'); fl.addColorStop(1, '#0A0F1E');
    c.fillStyle = fl; c.fillRect(-300, 380, 2200, 600);
    c.strokeStyle = 'rgba(51,67,110,.28)'; c.lineWidth = 1;
    for (let i = 0; i <= 14; i++) { c.beginPath(); c.moveTo(-300 + i * 170, 380); c.lineTo(-460 + i * 240, 940); c.stroke(); }
    for (let y = 420; y < 940; y += 64) { c.beginPath(); c.moveTo(-300, y); c.lineTo(1900, y); c.stroke(); }
    txt(c, this.mode === 'formalization' ? 'ЦЕХ 2 · КОНСТРУКТОРСКОЕ БЮРО' : 'ЦЕХ 3 · РАЗРАБОТКА', 800, 60, { s: 15, c: P.dim, w: 700, a: 'center', ls: 6 });

    this.kanbanBoard(c, t);
    // кран-балка и стапель
    this.crane(c, t);
    // столы
    for (const d of this.desks()) this.desk(c, d, t, T);
    // конвейеры к гейтам
    c.fillStyle = '#10192F'; rr(c, 200, 646, 1150, 14, 7); c.fill();
    c.strokeStyle = '#223052'; rr(c, 200, 646, 1150, 14, 7); c.stroke();
    c.strokeStyle = 'rgba(255,176,32,.5)'; c.lineWidth = 3; c.setLineDash([10, 14]); c.lineDashOffset = -t * 130;
    c.beginPath(); c.moveTo(210, 653); c.lineTo(1340, 653); c.stroke(); c.setLineDash([]);
    // обратный красный конвейер
    c.strokeStyle = 'rgba(255,93,108,.5)'; c.lineWidth = 3; c.setLineDash([6, 10]); c.lineDashOffset = t * 90;
    c.beginPath(); c.moveTo(1330, 726); c.lineTo(320, 726); c.stroke(); c.setLineDash([]);
    txt(c, 'rework loop', 820, 748, { s: 10, c: 'rgba(255,93,108,.7)', m: 1, a: 'center' });
    // гейты
    this.gate(c, 1418, 560, t, T, '#6FD3E8');
    // частицы сварки
    for (const s of this.sparks) { c.globalAlpha = alpha * s.a; c.fillStyle = P.amb2; c.fillRect(s.x, s.y, 2.5, 2.5); }
    c.restore();
  },
  kanbanBoard(c, t) {
    const x = 520, y = 100, w = 560, h = 190;
    c.fillStyle = 'rgba(20,30,56,.85)'; rr(c, x, y, w, h, 10); c.fill();
    c.strokeStyle = P.line; c.stroke();
    txt(c, 'KANBAN · проекция цикла', x + 16, y + 24, { s: 11, c: P.dim, m: 1 });
    const heads = ['TODO', 'В РАБОТЕ', 'РЕВЬЮ', 'ГОТОВО'], cw = (w - 24) / 4;
    for (let i = 0; i < 4; i++) {
      txt(c, heads[i], x + 12 + i * cw + cw / 2, y + 52, { s: 10, c: i === 3 ? P.grn : P.dim, w: 700, a: 'center', ls: 1.5 });
      c.strokeStyle = 'rgba(42,59,102,.6)'; c.beginPath(); c.moveTo(x + 12 + i * cw, y + 62); c.lineTo(x + 12 + (i + 1) * cw - 6, y + 62); c.stroke();
    }
    const labels = this.mode === 'formalization' ? ['prd', 'srs', 'uc', 'ac'] : ['dev-1', 'dev-2', 'dev-3', 'rev', 'dev-4', 'ver'];
    this.kanban.forEach((k2, i) => {
      k2.label = labels[i % labels.length];
      const step = Math.floor((t + k2.seed * 3) / 6);
      const prog = sm(0, 1, ((t + k2.seed * 3) % 6) / 6);
      const tgt = (step + i) % 4;
      const from = (step + i - 1 + 4) % 4;
      const col = i === 0 ? 3 : lerp(from, tgt, prog);
      const cy = y + 78 + (i % 3) * 34, cxp = x + 14 + col * cw + 6;
      c.fillStyle = '#1B2547'; rr(c, cxp, cy, cw - 14, 26, 5); c.fill();
      c.strokeStyle = col > 2.6 ? 'rgba(61,220,151,.6)' : P.line2; c.stroke();
      c.fillStyle = col > 2.6 ? P.grn : P.mut;
      c.beginPath(); c.arc(cxp + 12, cy + 13, 3, 0, TAU); c.fill();
      txt(c, k2.label || '', cxp + 22, cy + 17, { s: 10.5, c: col > 2.6 ? P.grn : P.mut, m: 1 });
    });
  },
  desk(c, d, t, T) {
    const y = 560, x = d.x, ga = c.globalAlpha;
    const cyc = this.deskCycle(d, t);
    const speed = this.replay ? 3.4 : 1;
    const ph = t * speed + d.seed; // фаза анимации робота
    // worktree-бокс
    c.strokeStyle = 'rgba(111,211,232,.35)'; c.lineWidth = 1.5; c.setLineDash([7, 6]);
    rr(c, x - 78, y - 150, 156, 190, 8); c.stroke(); c.setLineDash([]);
    txt(c, `worktree@${(d.seed * 9999 | 0).toString(16)}`.padEnd(10, ' '), x, y - 158, { s: 9, c: 'rgba(111,211,232,.55)', m: 1, a: 'center' });
    // стол
    c.fillStyle = '#141E38'; rr(c, x - 70, y - 20, 140, 16, 4); c.fill();
    c.fillStyle = '#0D1526'; c.fillRect(x - 64, y - 4, 10, 46); c.fillRect(x + 54, y - 4, 10, 46);
    // деталь над столом
    if (d.kind === 'doc') this.docPart(c, x, y - 74, cyc, d);
    else if (d.kind === 'code') this.codePart(c, x, y - 74, cyc, d);
    else this.badgePart(c, x, y - 74, cyc, d);
    // робот
    this.robot(c, x, y - 44, ph, cyc, d, T);
    // статус-чип
    const st = { craft: ['в работе', P.amb2], send: ['сдаёт партию', P.cyan], scan: ['НА ГЕЙТЕ', P.cyan], ret: ['РЕМОНТ', P.red], fix: ['ремонт', P.red], scan2: ['НА ГЕЙТЕ', P.cyan], done: ['принято ✓', P.grn] }[cyc.p] || ['…', P.mut];
    c.fillStyle = 'rgba(10,15,30,.8)'; rr(c, x - 44, y - 176, 88, 20, 10); c.fill();
    c.strokeStyle = st[1]; c.stroke();
    txt(c, st[0], x, y - 162, { s: 9.5, c: st[1], w: 700, a: 'center' });
    txt(c, d.id, x, y + 64, { s: 11, c: P.dim, w: 700, a: 'center', ls: 1.5 });
    // поднос на конвейере
    if (cyc.p === 'send' || cyc.p === 'scan' || cyc.p === 'ret') {
      const k = cyc.p === 'send' ? eo(cyc.k) : cyc.p === 'ret' ? 1 - eo(cyc.k) : 1;
      const tx = lerp(x, 1360, k);
      c.fillStyle = '#1B2547'; rr(c, tx - 20, 632, 40, 14, 3); c.fill();
      c.fillStyle = cyc.p === 'ret' ? 'rgba(255,93,108,.8)' : 'rgba(255,217,122,.85)';
      c.fillRect(tx - 10, 626, 20, 8);
    }
    // зелёное клеймо у 'done'
    if (cyc.p === 'done' && cyc.k < .5) {
      const k = cyc.k / .5;
      c.save(); c.translate(x + 60, y - 90); c.rotate(lerp(-.2, -.06, k)); c.scale(lerp(1.8, 1, eo(k)), lerp(1.8, 1, eo(k)));
      c.globalAlpha = ga * (1 - sm(.6, 1, k)); c.strokeStyle = P.grn; c.lineWidth = 2;
      rr(c, -34, -12, 68, 24, 4); c.stroke();
      txt(c, 'ПРИНЯТО', 0, 4, { s: 9, c: P.grn, w: 800, a: 'center' }); c.restore();
    }
  },
  docPart(c, x, y, cyc, d) {
    const grow = cyc.p === 'craft' ? sm(0, 1, cyc.k) : cyc.p === 'fix' ? .6 + .4 * cyc.k : 1;
    c.fillStyle = '#F4F7FF'; rr(c, x - 26, y - 18, 52, 62, 4); c.fill();
    c.fillStyle = P.bg; c.fillRect(x - 20, y - 12, 40, 6);
    c.strokeStyle = '#C7D3EE'; c.lineWidth = 2;
    const n = Math.round(grow * 7);
    for (let i = 0; i < n; i++) { const w2 = 12 + ((d.seed * 7 + i * 13) % 26); c.beginPath(); c.moveTo(x - 20, y + 2 + i * 6.6); c.lineTo(x - 20 + w2, y + 2 + i * 6.6); c.stroke(); }
    c.strokeStyle = '#223052'; c.lineWidth = 1.5; rr(c, x - 26, y - 18, 52, 62, 4); c.stroke();
    txt(c, d.part, x, y - 26, { s: 9.5, c: P.mut, m: 1, a: 'center' });
  },
  codePart(c, x, y, cyc, d) {
    const grow = cyc.p === 'craft' ? sm(0, 1, cyc.k) : cyc.p === 'fix' ? .5 + .5 * cyc.k : 1;
    c.fillStyle = '#10192F'; rr(c, x - 30, y - 20, 60, 66, 5); c.fill();
    c.strokeStyle = P.line2; c.stroke();
    c.fillStyle = P.line; c.fillRect(x - 30, y - 20, 60, 10);
    c.fillStyle = '#FF5D6C'; c.beginPath(); c.arc(x - 22, y - 15, 2, 0, TAU); c.fill();
    c.fillStyle = P.amb; c.beginPath(); c.arc(x - 14, y - 15, 2, 0, TAU); c.fill();
    c.fillStyle = P.grn; c.beginPath(); c.arc(x - 6, y - 15, 2, 0, TAU); c.fill();
    const n = Math.round(grow * 8);
    for (let i = 0; i < n; i++) {
      const w2 = 8 + ((d.seed * 11 + i * 17) % 40);
      c.fillStyle = i % 3 === 0 ? 'rgba(255,176,32,.8)' : i % 3 === 1 ? 'rgba(126,166,224,.8)' : 'rgba(61,220,151,.7)';
      c.fillRect(x - 24, y - 4 + i * 6.4, w2, 2.6);
    }
    txt(c, d.part, x, y - 28, { s: 9.5, c: P.mut, m: 1, a: 'center' });
  },
  badgePart(c, x, y, cyc, d) {
    const rev = d.kind === 'rev';
    c.fillStyle = rev ? 'rgba(255,93,108,.08)' : 'rgba(111,211,232,.08)';
    rr(c, x - 30, y - 20, 60, 66, 5); c.fill();
    c.strokeStyle = rev ? 'rgba(255,93,108,.5)' : 'rgba(111,211,232,.5)'; c.stroke();
    txt(c, rev ? 'РЕВЬЮ' : 'VERIFY', x, y + 4, { s: 10, c: rev ? P.red : P.cyan, w: 800, a: 'center' });
    txt(c, rev ? 'read-only' : 'AC→tests', x, y + 22, { s: 8.5, c: P.dim, m: 1, a: 'center' });
    if (rev) { // связаны руки
      c.strokeStyle = P.red; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x - 16, y + 36); c.quadraticCurveTo(x, y + 46, x + 16, y + 36); c.stroke();
    }
  },
  robot(c, x, y, ph, cyc, d, T) {
    const work = cyc.p === 'craft' || cyc.p === 'fix';
    const bob = work ? Math.sin(ph * 6) * 2 : Math.sin(ph * 1.2) * 1.2;
    const draw = (px, py, a) => {
      c.save(); c.globalAlpha = a; c.translate(px, py + bob);
      // корпус
      c.fillStyle = '#1B2547'; rr(c, -20, -26, 40, 46, 9); c.fill();
      c.strokeStyle = P.line2; c.lineWidth = 1.5; c.stroke();
      // голова-визор
      c.fillStyle = '#141E38'; rr(c, -16, -44, 32, 20, 7); c.fill(); c.stroke();
      const glow = work ? .9 : .45;
      c.fillStyle = `rgba(255,176,32,${glow})`; rr(c, -11, -38, 22, 7, 3.5); c.fill();
      // бейдж модели
      c.fillStyle = P.line; rr(c, -12, -12, 24, 12, 3); c.fill();
      txt(c, this.replay ? 'RPL' : 'GLM', 0, -3, { s: 7.5, c: this.replay ? P.cyan : P.amb2, m: 1, a: 'center', w: 700 });
      // руки
      c.strokeStyle = P.line2; c.lineWidth = 4; c.lineCap = 'round';
      const aw = work ? Math.sin(ph * 9) * .5 : .1;
      c.beginPath(); c.moveTo(-20, -18); c.lineTo(-30 - aw * 6, -2 + aw * 4); c.lineTo(-24 - aw * 10, 12 - aw * 6); c.stroke();
      c.beginPath(); c.moveTo(20, -18); c.lineTo(30 + aw * 6, -2 - aw * 4); c.lineTo(24 + aw * 10, 12 + aw * 6); c.stroke();
      // антенна
      c.beginPath(); c.moveTo(0, -44); c.lineTo(0, -52); c.stroke();
      c.fillStyle = `rgba(255,93,108,${.4 + .4 * Math.sin(ph * 3)})`; c.beginPath(); c.arc(0, -53, 2.2, 0, TAU); c.fill();
      c.restore();
    };
    if (this.replay) { draw(x - 8, y, .12); draw(x - 3, y, .22); } // шлейф дежавю
    draw(x, y, 1);
  },
  gate(c, x, y, t, T, colr) {
    const w = 120, h = 190, top = y - h / 2 - 40;
    c.fillStyle = '#141E38'; c.fillRect(x - w / 2, top, 14, h + 40); c.fillRect(x + w / 2 - 14, top, 14, h + 40);
    c.fillStyle = '#1B2547'; rr(c, x - w / 2 - 8, top - 26, w + 16, 30, 6); c.fill();
    txt(c, 'ГЕЙТ · ОТК', x, top - 6, { s: 10.5, c: P.amb2, w: 700, a: 'center', ls: 2 });
    // сканер
    const scanning = ((t % 4) < 1.2);
    c.fillStyle = 'rgba(18,25,46,.9)'; c.fillRect(x - w / 2 + 14, top + 8, w - 28, h - 20);
    c.strokeStyle = 'rgba(111,211,232,.4)'; c.strokeRect(x - w / 2 + 14, top + 8, w - 28, h - 20);
    if (scanning) {
      const k = (t % 4) / 1.2;
      const by = lerp(top + 12, top + h - 16, eo(k));
      c.fillStyle = 'rgba(111,211,232,.75)'; c.fillRect(x - w / 2 + 18, by, w - 36, 2.5);
      c.fillStyle = radial(c, x, by, 40, 'rgba(111,211,232,$)', .18, 0); c.fillRect(x - 60, by - 40, 120, 80);
    }
    // клеймо-выход
    const stampT = (t % 9);
    if (stampT > 4 && stampT < 5) {
      const k = (stampT - 4);
      c.save(); c.translate(x, top + 40); c.rotate(-.08);
      const sc = lerp(2, 1, eo(k)); c.scale(sc, sc);
      c.globalAlpha = 1 - sm(.7, 1, k);
      c.strokeStyle = P.grn; c.lineWidth = 2; rr(c, -38, -13, 76, 26, 4); c.stroke();
      txt(c, 'ПРИНЯТО', 0, 4, { s: 10, c: P.grn, w: 800, a: 'center' });
      c.restore();
    }
    txt(c, 'GateRun → GateDecision', x, top + h + 34, { s: 9.5, c: P.dim, m: 1, a: 'center' });
  },
  crane(c, t) {
    const x = 1290, y = 330; // стапель
    // рельса
    c.strokeStyle = '#223052'; c.lineWidth = 4; c.beginPath(); c.moveTo(1150, 84); c.lineTo(1460, 84); c.stroke();
    const k = this.craneT(t);
    // траектория: к гейту → вниз → вверх → к стапелю
    let tx, ty, holding = false;
    if (k < .2) { tx = lerp(1290, 1400, k / .2); ty = 100; }
    else if (k < .35) { tx = 1400; ty = lerp(100, 460, eio((k - .2) / .15)); }
    else if (k < .5) { holding = true; tx = 1400; ty = lerp(460, 100, eio((k - .35) / .15)); }
    else if (k < .7) { holding = true; tx = lerp(1400, 1290, (k - .5) / .2); ty = 100; }
    else { tx = 1290; ty = 100; }
    // стапель: изделие собирается
    c.strokeStyle = 'rgba(255,217,122,.7)'; c.lineWidth = 2.5;
    rr(c, x - 110, y - 70, 220, 150, 8); c.stroke();
    txt(c, 'PRODUCT', x, y - 82, { s: 10, c: P.dim, w: 700, a: 'center', ls: 2 });
    const seg = 4;
    for (let i = 0; i < seg; i++) {
      const filled = i < this.merges;
      const sx = x - 100 + (i % 2) * 105, sy = y - 58 + Math.floor(i / 2) * 72;
      if (filled) {
        c.fillStyle = `rgba(255,176,32,${.12 + .06 * Math.sin(t * 2 + i)})`; rr(c, sx, sy, 95, 62, 5); c.fill();
        c.strokeStyle = 'rgba(255,217,122,.5)'; rr(c, sx, sy, 95, 62, 5); c.stroke();
        txt(c, ['auth', 'api', 'ui', 'calc'][i], sx + 47, sy + 35, { s: 11, c: P.amb2, m: 1, a: 'center' });
      } else {
        c.strokeStyle = 'rgba(42,59,102,.8)'; c.setLineDash([5, 5]); rr(c, sx, sy, 95, 62, 5); c.stroke(); c.setLineDash([]);
      }
    }
    // трос и клешня
    c.strokeStyle = '#33436E'; c.lineWidth = 2; c.beginPath(); c.moveTo(tx, 84); c.lineTo(tx, ty); c.stroke();
    c.save(); c.translate(tx, ty);
    c.strokeStyle = P.amb; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(-14, 0); c.lineTo(-8, 16); c.moveTo(14, 0); c.lineTo(8, 16); c.stroke();
    if (holding) { c.fillStyle = P.amb2; rr(c, -12, 12, 24, 16, 3); c.fill(); }
    c.restore();
    txt(c, 'merge → main', x, y + 100, { s: 10, c: 'rgba(61,220,151,.8)', m: 1, a: 'center' });
  },
  // сценарный курьер акта 2: контракт AC летит к гейту и замерзает
  freezeCard(c, T) {
    if (Director.mode !== 'cine' || T < 24.5 || T > 34.8) return;
    const u = sm(24.5, 33.8, T), frost = sm(29.2, 33.2, T);
    const x = lerp(1090, 1380, eo(u)), y = lerp(560 - 74, 540, u * .4);
    c.save(); c.translate(x, y);
    const s = 1 + frost * .12; c.scale(s, s);
    c.fillStyle = radial(c, 0, 0, 80, 'rgba(111,211,232,$)', .22 * frost, 0); c.fillRect(-80, -80, 160, 160);
    c.fillStyle = '#F4F7FF'; rr(c, -32, -22, 64, 44, 4); c.fill();
    c.strokeStyle = '#223052'; c.lineWidth = 1.5; rr(c, -32, -22, 64, 44, 4); c.stroke();
    txt(c, 'AC-контракт', 0, -8, { s: 8.5, c: '#0A0F1E', w: 800, a: 'center' });
    c.strokeStyle = '#93A5CE'; c.lineWidth = 1;
    for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(-24, 0 + i * 6); c.lineTo(-24 + 20 + i * 6, 0 + i * 6); c.stroke(); }
    // мороз
    if (frost > 0) {
      c.globalAlpha = frost * .35; c.fillStyle = '#DFF6FF'; rr(c, -32, -22, 64, 44, 4); c.fill(); c.globalAlpha = 1;
      c.strokeStyle = `rgba(111,211,232,${frost})`; c.lineWidth = 1;
      const fr = sr(Math.round(T * 3) + 5);
      for (let i = 0; i < 7; i++) {
        const a = fr() * TAU, r0 = 8 + fr() * 18;
        let px = Math.cos(a) * r0, py = Math.sin(a) * r0 * .6;
        c.beginPath(); c.moveTo(px, py);
        for (let j = 0; j < 3; j++) { const a2 = fr() * TAU; px += Math.cos(a2) * 7; py += Math.sin(a2) * 7; c.lineTo(px, py); }
        c.stroke();
      }
      // печать-хэш
      const seal = sm(32.4, 33.4, T);
      if (seal > 0) {
        c.save(); c.rotate(-.3); c.scale(lerp(1.6, 1, eo(seal)), lerp(1.6, 1, eo(seal)));
        c.strokeStyle = P.cyan; c.lineWidth = 2; c.beginPath(); c.arc(14, 8, 11, 0, TAU); c.stroke();
        txt(c, '#', 14, 12, { s: 10, c: P.cyan, m: 1, a: 'center', w: 700 });
        c.restore();
        txt(c, 'sha256:9f3c…a1', 0, 40, { s: 8.5, c: P.cyan, m: 1, a: 'center' });
      }
    }
    c.restore();
  }
};
Workshop.init();

/* ============================ СЦЕНА: РАБОЧИЙ СТОЛ =========================
   Крафтовый стол в духе Metro: pegboard инструментов, контракт под печатью,
   полка точных материалов, приборы, робот-руки, гейт-арка справа.            */
const PARTS = {
  'auth.ts': [
    [['k', 6], ['f', 3], ['v', 8], ['f', 10], ['c', 14]],
    [['f', 8], ['v', 4], ['s', 16]],
    [['k', 5], ['v', 7], ['f', 2], ['c', 18]],
    [['v', 4], ['f', 12], ['s', 12]],
    [['k', 4], ['v', 10], ['c', 16]],
    [],
    [['k', 6], ['f', 9], ['v', 3], ['c', 12]],
    [['f', 6], ['v', 6], ['s', 18]],
    [['c', 26]],
    [['k', 5], ['v', 9], ['f', 5], ['c', 10]],
    [['v', 3], ['f', 14]],
    [['s', 20]],
    [['k', 7], ['v', 5], ['c', 15]],
    [['f', 4], ['v', 8], ['s', 10], ['c', 8]],
  ],
  'api.ts': [
    [['k', 5], ['f', 10], ['v', 6]],
    [['v', 4], ['f', 12], ['c', 12]],
    [['k', 6], ['s', 14], ['c', 10]],
    [['f', 8], ['v', 8]],
    [['k', 4], ['v', 12], ['c', 14]],
    [['c', 24]],
    [['f', 6], ['s', 16], ['v', 4]],
    [['k', 8], ['v', 6], ['f', 6], ['c', 8]],
    [['v', 10], ['f', 8]],
    [['s', 18], ['c', 8]],
    [['k', 6], ['f', 4], ['v', 9], ['c', 12]],
    [['f', 14], ['v', 4]],
  ],
};
const TOKC = { k: '#FFB020', f: '#F4F7FF', v: '#7EA6E0', s: '#3DDC97', c: '#66799F' };
const Desk = {
  cam: { x: 800, y: 480, z: 1 },
  t0: 0, part: 'auth.ts', deskId: 'DEV-1',
  dust: [], sparks: [],
  // мастер-таблица фаз: [имя, длительность] — первый цикл scripted: брак → ремонт → принято
  table: [['idle', .8], ['pick', .9], ['craft', 6], ['check', 1.6], ['seal', 1], ['send', 1.3], ['scan', 1.6],
  ['tag', 1], ['ret', 1.6], ['read', 1.5], ['fix', 3.2], ['seal2', 1], ['send2', 1.3], ['scan2', 1.6], ['stamp', 1], ['crane', 2.4], ['reset', .6], ['idle2', 1.4]],
  ambient: [['idle', .6], ['pick', .7], ['craft', 3.4], ['check', 1.2], ['seal', .7], ['send', .9], ['scan', 1.2],
  ['tag', .7], ['ret', 1], ['read', .9], ['fix', 2], ['seal2', .7], ['send2', .9], ['scan2', 1.2], ['stamp', .8], ['crane', 1.6], ['reset', .4], ['idle2', 1]],
  total1: 0, totalA: 0,
  init() { this.total1 = this.table.reduce((s, p) => s + p[1], 0); this.totalA = this.ambient.reduce((s, p) => s + p[1], 0); },
  reset(t, part) { this.t0 = t; if (part) this.part = part; this.dust = []; this.sparks = []; },
  phase(t) {
    let u = t - this.t0;
    if (u < 0) u = 0;
    if (u < this.total1) {
      let acc = 0;
      for (const [name, d] of this.table) { if (u < acc + d) return { name, k: (u - acc) / d, first: true }; acc += d; }
    }
    const w = (u - this.total1) % this.totalA, idx = Math.floor((u - this.total1) / this.totalA);
    let acc = 0;
    for (const [name, d] of this.ambient) { if (w < acc + d) return { name, k: (w - acc) / d, first: false, idx }; acc += d; }
    return { name: 'idle', k: 0, first: false };
  },
  update(dt, t) {
    if (Math.random() < .3 && this.dust.length < 50) this.dust.push({ x: 620 + Math.random() * 380, y: 200 + Math.random() * 300, r: Math.random() * 1.6 + .5, ph: Math.random() * TAU, sp: .2 + Math.random() * .5 });
    for (const d of this.dust) d.ph += dt * d.sp;
    const ph = this.phase(t);
    if ((ph.name === 'craft' || ph.name === 'fix') && Math.random() < .35 && this.sparks.length < 30)
      this.sparks.push({ x: 830 + (Math.random() - .5) * 90, y: 280 + Math.random() * 140, vx: (Math.random() - .5) * 160, vy: -40 - Math.random() * 80, a: 1 });
    for (const s of this.sparks) { s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 300 * dt; s.a -= 2.4 * dt; }
    this.sparks = this.sparks.filter(s => s.a > 0);
  },
  draw(c, t, alpha, T) {
    c.save(); c.globalAlpha = alpha;
    // стена
    const wl = c.createLinearGradient(0, -100, 0, 500);
    wl.addColorStop(0, '#0E1830'); wl.addColorStop(1, '#101B36');
    c.fillStyle = wl; c.fillRect(-300, -300, 2200, 800);
    c.strokeStyle = 'rgba(42,59,102,.5)'; c.lineWidth = 1;
    for (let x = -300; x < 1900; x += 160) { c.beginPath(); c.moveTo(x, -300); c.lineTo(x, 470); c.stroke(); }
    c.beginPath(); c.moveTo(-300, 470); c.lineTo(1900, 470); c.stroke();
    this.bench(c);
    this.pegboard(c, t);
    this.lamp(c, t, T);
    this.contract(c, T);
    this.shelf(c, t);
    this.panel(c, t);
    const ph = this.phase(t);
    this.editor(c, t, ph);
    this.tray(c, ph);
    this.gate(c, t, ph);
    this.arms(c, t, ph);
    this.crane(c, ph);
    // пылинки в конусе лампы
    for (const d of this.dust) {
      const a = .25 + .2 * Math.sin(d.ph * 3);
      c.fillStyle = `rgba(255,217,122,${a * alpha})`;
      c.beginPath(); c.arc(d.x + Math.sin(d.ph) * 8, d.y + Math.cos(d.ph * .7) * 5, d.r, 0, TAU); c.fill();
    }
    for (const s of this.sparks) { c.globalAlpha = alpha * s.a; c.fillStyle = P.amb2; c.fillRect(s.x, s.y, 2, 2); }
    c.globalAlpha = alpha;
    // табличка стола
    c.fillStyle = 'rgba(20,30,56,.85)'; rr(c, 560, 486, 480, 26, 6); c.fill(); c.strokeStyle = P.line; c.stroke();
    txt(c, `Workplace ${this.deskId} · WorkerExecution #${100 + (Math.floor(t / this.total1) % 7)}`, 800, 503, { s: 10.5, c: P.mut, m: 1, a: 'center' });
    c.restore();
  },
  bench(c) {
    // столешница
    const g = c.createLinearGradient(0, 470, 0, 540);
    g.addColorStop(0, '#2E2740'); g.addColorStop(1, '#241F33');
    c.fillStyle = g; c.fillRect(-300, 470, 2200, 70);
    c.strokeStyle = '#3A3152'; c.lineWidth = 2; c.beginPath(); c.moveTo(-300, 470); c.lineTo(1900, 470); c.stroke();
    // передница
    c.fillStyle = '#171226'; c.fillRect(-300, 540, 2200, 400);
    c.strokeStyle = 'rgba(58,49,82,.7)'; c.lineWidth = 1;
    for (let x = -280; x < 1900; x += 120) { c.beginPath(); c.moveTo(x, 545); c.lineTo(x - 14, 940); c.stroke(); }
    // лоток с деталями слева
    c.fillStyle = '#0F1930'; rr(c, 250, 486, 120, 44, 5); c.fill(); c.strokeStyle = P.line; c.stroke();
    for (let i = 0; i < 8; i++) { c.fillStyle = ['#33436E', '#7EA6E0', '#FFB020'][i % 3]; c.fillRect(262 + (i % 4) * 26, 496 + Math.floor(i / 4) * 16, 14, 6); }
    txt(c, 'компоненты', 310, 548, { s: 9, c: P.dim, a: 'center' });
  },
  pegboard(c, t) {
    const x = 160, y = 150, w = 320, h = 290;
    c.fillStyle = '#15202E'; rr(c, x, y, w, h, 8); c.fill();
    c.strokeStyle = '#2A3B66'; c.lineWidth = 2; rr(c, x, y, w, h, 8); c.stroke();
    c.fillStyle = 'rgba(42,59,102,.5)';
    for (let gx = x + 20; gx < x + w - 10; gx += 26) for (let gy = y + 20; gy < y + h - 10; gy += 26) { c.beginPath(); c.arc(gx, gy, 1.6, 0, TAU); c.fill(); }
    txt(c, 'ИНСТРУМЕНТЫ · профиль исполнения', x + w / 2, y - 10, { s: 10, c: P.dim, w: 700, a: 'center', ls: 1.5 });
    const ph = this.phase(t);
    const tools = [
      { id: 'read', label: 'read', x: x + 52, y: y + 56, draw: tc => { tc.beginPath(); tc.moveTo(-9, -8); tc.lineTo(4, -8); tc.lineTo(4, 8); tc.lineTo(-9, 8); tc.closePath(); tc.stroke(); tc.beginPath(); tc.moveTo(-9, -2); tc.lineTo(4, -2); tc.stroke(); } },
      { id: 'grep', label: 'grep', x: x + 140, y: y + 56, draw: tc => { tc.beginPath(); tc.arc(-3, -2, 6, 0, TAU); tc.stroke(); tc.beginPath(); tc.moveTo(2, 3); tc.lineTo(9, 10); tc.stroke(); } },
      { id: 'edit', label: 'edit', x: x + 228, y: y + 56, draw: tc => { tc.beginPath(); tc.moveTo(-8, 8); tc.lineTo(-5, -1); tc.lineTo(6, -12); tc.lineTo(11, -7); tc.lineTo(0, 4); tc.closePath(); tc.stroke(); } },
      { id: 'bash', label: 'bash', x: x + 52, y: y + 160, draw: tc => { tc.strokeRect(-9, -7, 18, 14); tc.beginPath(); tc.moveTo(-4, -2); tc.lineTo(-1, 0); tc.lineTo(-4, 2); tc.moveTo(2, 2); tc.lineTo(5, 2); tc.stroke(); } },
      { id: 'web', label: 'web', x: x + 140, y: y + 160, draw: tc => { tc.beginPath(); tc.arc(0, 0, 8, .4, TAU - .8); tc.stroke(); tc.beginPath(); tc.ellipse(0, 0, 8, 3.2, 0, 0, TAU); tc.stroke(); } },
      { id: 'test', label: 'test', x: x + 228, y: y + 160, draw: tc => { tc.beginPath(); tc.moveTo(-6, -8); tc.lineTo(4, -8); tc.lineTo(-1, 1); tc.lineTo(6, 1); tc.lineTo(-6, 10); tc.lineTo(-2, 0); tc.lineTo(-8, 0); tc.closePath(); tc.stroke(); } },
    ];
    const usingEdit = (ph.name === 'craft' || ph.name === 'fix');
    for (const tl of tools) {
      const taken = tl.id === 'edit' && usingEdit;
      // крюк
      c.strokeStyle = '#66799F'; c.lineWidth = 2; c.beginPath(); c.arc(tl.x, tl.y - 16, 3, .5, TAU - 1.2); c.stroke();
      if (!taken) {
        c.save(); c.translate(tl.x, tl.y);
        c.strokeStyle = '#C7D3EE'; c.lineWidth = 2;
        tl.draw(c);
        c.restore();
      }
      txt(c, tl.label, tl.x, tl.y + 30, { s: 9.5, c: taken ? P.amb2 : P.dim, m: 1, a: 'center' });
      const cnt = 3 + ((tl.x / 7 | 0) % 9) + (usingEdit && tl.id === 'edit' ? Math.floor(t) % 3 : 0);
      txt(c, '×' + cnt, tl.x + 26, tl.y + 30, { s: 8.5, c: '#4A5B85', m: 1 });
    }
    // пустые гвозди — профиль ниже: у текстового воркера нет bash/edit
    txt(c, 'профиль: text-worker · bash ✕ · write ✕', x + w / 2, y + h - 16, { s: 9, c: '#4A5B85', m: 1, a: 'center' });
  },
  lamp(c, t, T) {
    const red = this.phase(t).name === 'tag';
    const x = 820, y = 60;
    c.strokeStyle = '#33436E'; c.lineWidth = 3; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, y); c.stroke();
    c.fillStyle = '#1B2547';
    c.beginPath(); c.moveTo(x - 16, y + 22); c.lineTo(x + 16, y + 22); c.lineTo(x + 7, y); c.lineTo(x - 7, y); c.closePath(); c.fill();
    c.strokeStyle = P.line2; c.stroke();
    // конус света
    const cone = c.createLinearGradient(0, y + 20, 0, 540);
    const col = red ? '255,93,108' : '255,200,110';
    cone.addColorStop(0, `rgba(${col},.30)`); cone.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = cone;
    c.beginPath(); c.moveTo(x - 9, y + 22); c.lineTo(x + 9, y + 22); c.lineTo(x + 330, 540); c.lineTo(x - 330, 540); c.closePath(); c.fill();
    c.fillStyle = radial(c, x, y + 26, 30, `rgba(${col},$)`, .8, 0); c.fillRect(x - 30, y - 4, 60, 60);
    // шнур
    c.strokeStyle = '#66799F'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x + 14, y + 16); c.quadraticCurveTo(x + 26, y + 42, x + 20 + Math.sin(t * 1.7) * 4, y + 58); c.stroke();
    c.fillStyle = P.amb; c.beginPath(); c.arc(x + 20 + Math.sin(t * 1.7) * 4, y + 60, 3, 0, TAU); c.fill();
  },
  contract(c, T) {
    const x = 1090, y = 130, w = 300, h = 180;
    c.fillStyle = '#0F1930'; rr(c, x, y, w, h, 6); c.fill();
    c.strokeStyle = '#2A3B66'; c.lineWidth = 2.5; rr(c, x + 6, y + 6, w - 12, h - 12, 4); c.stroke();
    txt(c, 'НАРЯД · WORK INTENT', x + w / 2, y + 28, { s: 10.5, c: P.amb2, w: 700, a: 'center', ls: 2 });
    // лист
    c.fillStyle = '#F4F7FF'; rr(c, x + 28, y + 42, w - 56, h - 60, 3); c.fill();
    c.strokeStyle = '#93A5CE'; c.lineWidth = 1;
    for (let i = 0; i < 6; i++) { const w2 = 30 + ((i * 37) % 90); c.beginPath(); c.moveTo(x + 40, y + 58 + i * 14); c.lineTo(x + 40 + w2, y + 58 + i * 14); c.stroke(); }
    // печать-хэш (заморозка)
    const pulse = .6 + .25 * Math.sin(T * 2.2);
    c.save(); c.translate(x + w - 52, y + h - 44); c.rotate(-.25);
    c.strokeStyle = P.cyan; c.lineWidth = 2; c.globalAlpha = pulse + .25;
    c.beginPath(); c.arc(0, 0, 15, 0, TAU); c.stroke();
    c.beginPath(); c.arc(0, 0, 10.5, 0, TAU); c.stroke();
    txt(c, '#', 0, 5, { s: 12, c: P.cyan, m: 1, a: 'center', w: 700 });
    c.restore();
    txt(c, 'AC · sha256:9f3c…a1 · frozen', x + w / 2, y + h - 12, { s: 9, c: P.cyan, m: 1, a: 'center' });
    // морозный блик
    c.fillStyle = radial(c, x + w - 52, y + h - 44, 46, 'rgba(111,211,232,$)', .12 * pulse, 0); c.fillRect(x + w - 100, y + h - 92, 96, 96);
  },
  shelf(c, t) {
    const x = 1070, y = 350, w = 400;
    c.strokeStyle = '#2A3B66'; c.lineWidth = 4; c.beginPath(); c.moveTo(x, y + 46); c.lineTo(x + w, y + 46); c.stroke();
    c.beginPath(); c.moveTo(x, y + 46); c.lineTo(x, y + 70); c.moveTo(x + w, y + 46); c.lineTo(x + w, y + 70); c.stroke();
    txt(c, 'ТОЧНЫЕ МАТЕРИАЛЫ · exact ProductRef', x + w / 2, y - 10, { s: 9.5, c: P.dim, w: 700, a: 'center', ls: 1 });
    const boxes = [
      { l: 'PRD', h: 'e3a1' }, { l: 'SRS', h: '7b02' }, { l: 'AC', h: '9f3c' },
    ];
    const ph = this.phase(t);
    const useAc = ph.name === 'craft' || ph.name === 'fix';
    boxes.forEach((b, i) => {
      const bx = x + 18 + i * 128, by = y - 2;
      const active = useAc && i === 2;
      const blocked = ph.name === 'craft' && ph.k > .3 && ph.k < .38 && i !== 2; // момент «не тот ящик»
      c.fillStyle = active ? 'rgba(255,176,32,.16)' : 'rgba(20,30,56,.9)';
      rr(c, bx, by, 108, 48, 5); c.fill();
      c.strokeStyle = active ? P.amb : blocked ? P.red : P.line2; c.lineWidth = active ? 2 : 1.5; c.stroke();
      txt(c, b.l, bx + 12, by + 21, { s: 13, c: active ? P.amb2 : P.mut, w: 800 });
      txt(c, b.h + '…', bx + 12, by + 38, { s: 9, c: active ? P.amb : P.dim, m: 1 });
      if (active) { c.fillStyle = radial(c, bx + 54, by + 24, 60, 'rgba(255,176,32,$)', .14, 0); c.fillRect(bx - 10, by - 36, 128, 120); }
      if (blocked) { // гекс-щит fence
        c.strokeStyle = 'rgba(255,93,108,.7)'; c.lineWidth = 1.5;
        for (let hx = 0; hx < 5; hx++) { const px = bx + 8 + hx * 24; c.beginPath(); c.moveTo(px, by - 8); c.lineTo(px + 8, by - 4); c.lineTo(px + 8, by + 8); c.lineTo(px, by + 12); c.lineTo(px - 8, by + 8); c.lineTo(px - 8, by + 4); c.closePath(); c.stroke(); }
      }
    });
  },
  panel(c, t) {
    const x = 290, y = 590, w = 230, h = 130;
    c.fillStyle = '#0F1930'; rr(c, x, y, w, h, 8); c.fill();
    c.strokeStyle = P.line; c.lineWidth = 2; rr(c, x + 8, y + 8, w - 16, h - 16, 5); c.stroke();
    txt(c, 'ПРИБОРЫ · CheckPlan', x + w / 2, y - 8, { s: 9.5, c: P.dim, w: 700, a: 'center', ls: 1 });
    const ph = this.phase(t);
    const ck = ph.name === 'check' ? ph.k : ph.name === 'craft' ? 0 : 1;
    const lamps = [
      { l: 'LINT', on: ck > .25, col: P.grn },
      { l: 'BUILD', on: ck > .6, col: P.grn },
      { l: 'TESTS', on: ck > .9 || (ph.name === 'check' && ph.k > .82 && ph.k < .88), col: ph.name === 'check' && ph.k > .82 && ph.k < .88 ? P.amb : P.grn },
    ];
    lamps.forEach((L, i) => {
      const lx = x + 30 + i * 66, ly = y + 34;
      c.fillStyle = '#0B1122'; c.beginPath(); c.arc(lx, ly, 10, 0, TAU); c.fill();
      c.strokeStyle = '#223052'; c.lineWidth = 2; c.beginPath(); c.arc(lx, ly, 10, 0, TAU); c.stroke();
      if (L.on) {
        c.fillStyle = L.col; c.beginPath(); c.arc(lx, ly, 6, 0, TAU); c.fill();
        c.fillStyle = radial(c, lx, ly, 22, L.col === P.grn ? 'rgba(61,220,151,$)' : 'rgba(255,176,32,$)', .3, 0); c.fillRect(lx - 22, ly - 22, 44, 44);
      }
      txt(c, L.l, lx, y + 62, { s: 8.5, c: L.on ? P.mut : P.dim, m: 1, a: 'center', w: L.on ? 700 : 400 });
    });
    // deny-by-default
    txt(c, 'deny by default · 4-значный вердикт', x + w / 2, y + 82, { s: 8, c: '#4A5B85', m: 1, a: 'center' });
    // два стрелочных прибора
    for (let g = 0; g < 2; g++) {
      const gx = x + 52 + g * 110, gy = y + 100;
      c.strokeStyle = '#223052'; c.lineWidth = 2; c.beginPath(); c.arc(gx, gy, 16, Math.PI * .8, Math.PI * 2.2); c.stroke();
      const work = ph.name === 'craft' || ph.name === 'fix';
      const a = Math.PI * 1.12 + (work ? .5 + .45 * Math.sin(t * 7 + g * 2) : .18);
      c.strokeStyle = P.amb; c.lineWidth = 2; c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + Math.cos(a) * 13, gy + Math.sin(a) * 13); c.stroke();
      c.fillStyle = '#33436E'; c.beginPath(); c.arc(gx, gy, 2.5, 0, TAU); c.fill();
    }
  },
  editor(c, t, ph) {
    const x = 640, y = 170, w = 350, h = 300;
    // окно-деталь
    c.fillStyle = '#10192F'; rr(c, x, y, w, h, 8); c.fill();
    c.strokeStyle = P.line2; c.lineWidth = 2; rr(c, x, y, w, h, 8); c.stroke();
    c.fillStyle = '#141E38'; rr(c, x, y, w, 30, 8); c.fill();
    c.fillStyle = '#FF5D6C'; c.beginPath(); c.arc(x + 16, y + 15, 4, 0, TAU); c.fill();
    c.fillStyle = P.amb; c.beginPath(); c.arc(x + 30, y + 15, 4, 0, TAU); c.fill();
    c.fillStyle = P.grn; c.beginPath(); c.arc(x + 44, y + 15, 4, 0, TAU); c.fill();
    txt(c, `${this.part} · worktree`, x + w / 2 + 10, y + 19, { s: 10.5, c: P.mut, m: 1, a: 'center' });
    // строки
    const lines = PARTS[this.part];
    const growK = ph.name === 'craft' ? ph.k : ph.name === 'fix' ? .55 + .45 * ph.k : ph.name === 'idle' || ph.name === 'pick' ? 0 : 1;
    const total = lines.reduce((s, l) => s + l.reduce((q, tk) => q + tk[1], 0) + 6, 0);
    let shown = growK * total, ly = y + 56, monos = 'Consolas';
    for (let i = 0; i < lines.length && shown > 0; i++, ly += 17) {
      let lx = x + 18;
      txt(c, String(i + 1).padStart(2, ' '), x + 14, ly, { s: 10, c: '#33436E', m: 1 });
      for (const [type, len] of lines[i]) {
        const take = Math.min(len, shown);
        if (take <= 0) break;
        c.fillStyle = TOKC[type];
        c.fillRect(lx, ly - 8, take * 7.2 * .55 + take * .9, 10);
        shown -= take; lx += take * 7.2 * .55 + take * .9 + 7;
        if (shown <= 0) break;
      }
      shown -= 6;
    }
    // дефектная ведомость при браке
    if (ph.name === 'tag' || ph.name === 'ret' || ph.name === 'read' || ph.name === 'fix') {
      const ap = ph.name === 'tag' ? eo(ph.k) : 1;
      c.save(); c.translate(x + w - 90, y + 40); c.rotate(.06); c.globalAlpha = ap;
      c.fillStyle = '#F4F7FF'; rr(c, -70, -12, 140, 88, 4); c.fill();
      c.fillStyle = P.red; c.fillRect(-70, -12, 140, 20);
      txt(c, 'ДЕФЕКТНАЯ ВЕДОМОСТЬ', 0, 2, { s: 8, c: '#fff', w: 800, a: 'center' });
      txt(c, 'RecoveryIssue#12', 0, 22, { s: 9, c: '#0A0F1E', m: 1, a: 'center', w: 700 });
      c.strokeStyle = '#93A5CE'; c.lineWidth = 1;
      for (let i = 0; i < 3; i++) { const on = ph.name === 'read' || ph.name === 'fix' ? ph.k * 3 > i : false; c.beginPath(); c.moveTo(-58, 38 + i * 12); c.lineTo(-58 + 60 + i * 20, 38 + i * 12); c.strokeStyle = on ? P.red : '#C7D3EE'; c.stroke(); }
      c.restore();
    }
    // подсветка строки при fix
    if (ph.name === 'fix') {
      const hl = Math.floor(ph.k * 6) % lines.length;
      c.fillStyle = 'rgba(255,176,32,.12)'; c.fillRect(x + 10, y + 50 + hl * 17, w - 20, 15);
    }
  },
  tray(c, ph) {
    // поднос CandidateSet: на столе → едет к гейту
    const sendPh = ph.name === 'send' || ph.name === 'send2' ? ph.k : ph.name === 'scan' || ph.name === 'scan2' ? 1 : ph.name === 'ret' ? 1 - ph.k : (ph.name === 'tag' || ph.name === 'stamp' ? 1 : 0);
    const onBelt = ph.name === 'send' || ph.name === 'send2' || ph.name === 'scan' || ph.name === 'scan2' || ph.name === 'tag' || ph.name === 'ret' || ph.name === 'stamp';
    if (!onBelt) {
      if (ph.name === 'seal' || ph.name === 'seal2') {
        const x = 1060, y = 600;
        c.fillStyle = '#1B2547'; rr(c, x - 45, y, 90, 26, 4); c.fill(); c.strokeStyle = P.line2; c.stroke();
        // печать манифеста
        if (ph.k > .4) {
          c.fillStyle = '#F4F7FF'; rr(c, x - 34, y - 26 * sm(.4, .8, ph.k), 68, 22, 2); c.fill();
          txt(c, `cs:${(4000 + Math.floor(ph.k * 900))} · 8b2f…e0`, x, y - 12 + 2, { s: 7.5, c: '#0A0F1E', m: 1, a: 'center' });
        }
        txt(c, 'CandidateSet · seal', x, y + 42, { s: 9, c: P.dim, m: 1, a: 'center' });
      }
      return;
    }
    const x = lerp(1075, 1395, eo(sendPh)), y = 640;
    // мини-конвейер
    c.strokeStyle = '#223052'; c.lineWidth = 8; c.beginPath(); c.moveTo(1050, 662); c.lineTo(1420, 662); c.stroke();
    c.strokeStyle = 'rgba(255,176,32,.4)'; c.lineWidth = 2; c.setLineDash([8, 10]); c.lineDashOffset = -performance.now() / 8;
    c.beginPath(); c.moveTo(1055, 662); c.lineTo(1415, 662); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#1B2547'; rr(c, x - 42, y - 4, 84, 24, 4); c.fill(); c.strokeStyle = ph.name === 'ret' ? 'rgba(255,93,108,.8)' : P.line2; c.stroke();
    c.fillStyle = ph.name === 'ret' ? 'rgba(255,93,108,.85)' : 'rgba(255,217,122,.9)';
    c.fillRect(x - 28, y - 14, 56, 12);
    txt(c, 'cs:4471', x, y + 12, { s: 8.5, c: P.mut, m: 1, a: 'center' });
  },
  gate(c, t, ph) {
    const x = 1480, top = 430, w = 130, h = 330;
    c.fillStyle = '#141E38'; c.fillRect(x - w / 2, top, 16, h); c.fillRect(x + w / 2 - 16, top, 16, h);
    c.fillStyle = '#1B2547'; rr(c, x - w / 2 - 10, top - 30, w + 20, 34, 6); c.fill();
    txt(c, 'ГЕЙТ ЦЕХА · ОТК', x, top - 8, { s: 11, c: P.amb2, w: 700, a: 'center', ls: 2 });
    c.fillStyle = 'rgba(18,25,46,.92)'; c.fillRect(x - w / 2 + 16, top + 10, w - 32, h - 30);
    // луч сканера
    const scanning = ph.name === 'scan' || ph.name === 'scan2';
    if (scanning) {
      const by = lerp(top + 16, top + h - 30, eo(ph.k));
      c.fillStyle = 'rgba(111,211,232,.8)'; c.fillRect(x - w / 2 + 20, by, w - 40, 3);
      c.fillStyle = radial(c, x, by, 50, 'rgba(111,211,232,$)', .2, 0); c.fillRect(x - 55, by - 50, 110, 100);
    }
    // клейма
    const stampNow = ph.name === 'scan' && ph.k > .75 || ph.name === 'tag' && ph.k < .6;
    if (stampNow) {
      const k = ph.name === 'scan' ? (ph.k - .75) / .25 : 1 - ph.k / .6;
      c.save(); c.translate(x, top + 120); c.rotate(lerp(-.18, -.04, eo(k))); const sc = lerp(2.4, 1, eo(k)); c.scale(sc, sc);
      c.strokeStyle = P.red; c.lineWidth = 2.5; rr(c, -52, -16, 104, 32, 4); c.stroke();
      txt(c, 'БРАК', 0, 6, { s: 14, c: P.red, w: 800, a: 'center', ls: 2 });
      c.restore();
      if (k < .4) { c.strokeStyle = `rgba(255,93,108,${.6 * (1 - k / .4)})`; c.lineWidth = 3; c.beginPath(); c.arc(x, top + 120, 40 + k * 120, 0, TAU); c.stroke(); }
    }
    if (ph.name === 'stamp') {
      c.save(); c.translate(x, top + 120); c.rotate(lerp(-.2, -.05, eo(ph.k))); const sc = lerp(2.6, 1, eo(clamp(ph.k * 1.6, 0, 1))); c.scale(sc, sc);
      c.globalAlpha = 1 - sm(.75, 1, ph.k);
      c.strokeStyle = P.grn; c.lineWidth = 2.5; rr(c, -56, -16, 112, 32, 4); c.stroke();
      txt(c, 'ПРИНЯТО', 0, 6, { s: 13, c: P.grn, w: 800, a: 'center', ls: 1 });
      c.restore();
    }
    txt(c, 'GateRun → GateDecision', x, top + h + 26, { s: 9.5, c: P.dim, m: 1, a: 'center' });
    txt(c, 'append-only', x, top + h + 42, { s: 8.5, c: '#4A5B85', m: 1, a: 'center' });
  },
  arms(c, t, ph) {
    // цели gripper'ов по фазе
    let L = [520, 470], R = [1080, 470];
    const hover = (cx2, cy2, k) => [cx2 + Math.sin(t * 5) * 8 * k, cy2 + Math.cos(t * 4) * 6 * k];
    if (ph.name === 'pick') { L = [lerp(520, 388, eo(ph.k)), lerp(470, 206, eo(ph.k))]; R = [980, 300]; }
    else if (ph.name === 'craft') { L = hover(760, 330, 1); R = hover(890, 350, 1); }
    else if (ph.name === 'fix') { L = hover(800, 340, 1); R = [870, 300]; }
    else if (ph.name === 'read') { L = [810, 400]; R = [880, 330]; }
    else if (ph.name === 'check') { L = [lerp(520, 400, eo(ph.k)), lerp(470, 640, eo(ph.k))]; }
    else if (ph.name === 'seal' || ph.name === 'seal2') { L = [1030, 610]; R = [1100, 610]; }
    else if (ph.name === 'crane') { L = [700, 470]; R = [940, 470]; }
    // правая рука держит ведомость при read
    this.arm(c, 560, 470, L[0], L[1], 200, 170, 1);
    this.arm(c, 1040, 470, R[0], R[1], 200, 170, -1);
    // инструмент в руке при craft
    if (ph.name === 'craft' || ph.name === 'fix') {
      c.save(); c.translate(L[0], L[1] - 4); c.strokeStyle = P.amb2; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-8, 8); c.lineTo(-5, -1); c.lineTo(6, -12); c.lineTo(11, -7); c.lineTo(0, 4); c.closePath(); c.stroke();
      c.restore();
    }
    if (ph.name === 'read') {
      c.save(); c.translate(R[0], R[1] - 6); c.fillStyle = '#F4F7FF'; rr(c, -20, -14, 40, 28, 2); c.fill();
      c.fillStyle = P.red; c.fillRect(-20, -14, 40, 7); c.restore();
    }
  },
  arm(c, bx, by, tx, ty, l1, l2, flip) {
    let dx = tx - bx, dy = ty - by, d = Math.hypot(dx, dy);
    const dc = clamp(d, Math.abs(l1 - l2) + 4, l1 + l2 - 4);
    const a = Math.atan2(dy, dx);
    const q = Math.acos(clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1));
    const a1 = a + q * flip;
    const ex = bx + Math.cos(a1) * l1, ey = by + Math.sin(a1) * l1;
    const fx = bx + Math.cos(a) * dc, fy = by + Math.sin(a) * dc;
    // базе — тумба
    c.fillStyle = '#1B2547'; rr(c, bx - 14, by - 8, 28, 16, 4); c.fill(); c.strokeStyle = P.line2; c.stroke();
    c.strokeStyle = '#33436E'; c.lineWidth = 9; c.lineCap = 'round';
    c.beginPath(); c.moveTo(bx, by); c.lineTo(ex, ey); c.lineTo(fx, fy); c.stroke();
    c.strokeStyle = P.line2; c.lineWidth = 7;
    c.beginPath(); c.moveTo(bx, by); c.lineTo(ex, ey); c.lineTo(fx, fy); c.stroke();
    c.fillStyle = P.amb; c.beginPath(); c.arc(bx, by, 5, 0, TAU); c.fill();
    c.fillStyle = '#141E38'; c.beginPath(); c.arc(ex, ey, 5, 0, TAU); c.fill(); c.strokeStyle = P.line2; c.lineWidth = 1.5; c.stroke();
    // клешня
    c.strokeStyle = P.amb; c.lineWidth = 3;
    c.save(); c.translate(fx, fy); c.rotate(a);
    c.beginPath(); c.moveTo(0, 0); c.lineTo(12, -8); c.moveTo(0, 0); c.lineTo(12, 8); c.stroke();
    c.restore();
  },
  crane(c, ph) {
    if (ph.name !== 'crane') return;
    const k = ph.k;
    let cy;
    if (k < .3) cy = lerp(-40, 610, eio(k / .3));
    else if (k < .55) { cy = 610; }  // схват
    else cy = lerp(610, -60, eio((k - .55) / .45));
    const cxp = lerp(1395, 1230, sm(.15, .85, k));
    c.strokeStyle = '#33436E'; c.lineWidth = 2; c.beginPath(); c.moveTo(cxp, -40); c.lineTo(cxp, cy); c.stroke();
    c.save(); c.translate(cxp, cy);
    c.strokeStyle = P.grn; c.lineWidth = 3;
    c.beginPath(); c.moveTo(-16, 0); c.lineTo(-9, 18); c.moveTo(16, 0); c.lineTo(9, 18); c.stroke();
    if (k > .3 && k < .6) { // деталь + сварка
      c.fillStyle = P.amb2; rr(c, -14, 14, 28, 18, 3); c.fill();
      for (let i = 0; i < 3; i++) {
        const a2 = Math.random() * TAU;
        c.fillStyle = P.grn; c.fillRect(Math.cos(a2) * 16, 20 + Math.sin(a2) * 8, 2, 2);
      }
      c.fillStyle = radial(c, 0, 24, 36, 'rgba(61,220,151,$)', .35, 0); c.fillRect(-36, -12, 72, 72);
    }
    c.restore();
    txt(c, 'merge → main', cxp, 700, { s: 10, c: 'rgba(61,220,151,.85)', m: 1, a: 'center' });
  }
};
Desk.init();

/* ============================ РЕЖИССЁР / ТАЙМЛАЙН ========================= */
const DUR = 95;
// кадры: {t0,t1,s,cam:[x,y,z]from→to, v from→to}
const SHOTS = [
  { t0: 0, t1: 13.5, s: 'factory', a: [800, 450, 1.00], b: [830, 458, 1.07], v: [.3, .3] },
  { t0: 13.5, t1: 17, s: 'factory', a: [830, 458, 1.07], b: [505, 480, 2.7], v: [.3, 1.5] },
  { t0: 17, t1: 25, s: 'workshop', a: [800, 462, 1.00], b: [740, 458, 1.12], v: [1.5, 1.5] },
  { t0: 25, t1: 31, s: 'workshop', a: [740, 458, 1.12], b: [540, 530, 1.45], v: [1.5, 1.5] },
  { t0: 31, t1: 34.6, s: 'workshop', a: [540, 530, 1.45], b: [720, 520, 1.55], v: [1.5, 1.5] },
  { t0: 34.6, t1: 38, s: 'workshop', a: [720, 520, 1.55], b: [800, 480, 1.2], v: [1.5, 2.7] },
  { t0: 38, t1: 51, s: 'desk', a: [830, 480, 1.00], b: [770, 492, 1.14], v: [2.7, 2.7] },
  { t0: 51, t1: 56, s: 'desk', a: [770, 492, 1.14], b: [1000, 505, 1.28], v: [2.7, 2.7] },
  { t0: 56, t1: 64, s: 'desk', a: [1000, 505, 1.28], b: [790, 500, 1.18], v: [2.7, 2.7] },
  { t0: 64, t1: 70.5, s: 'desk', a: [790, 500, 1.18], b: [930, 480, 1.22], v: [2.7, 2.7] },
  { t0: 70.5, t1: 74, s: 'desk', a: [930, 480, 1.22], b: [800, 480, 1.0], v: [2.7, 1.5] },
  { t0: 74, t1: 80, s: 'workshop', a: [800, 462, 1.05], b: [800, 455, 1.14], v: [1.5, 1.5] },
  { t0: 80, t1: 86.5, s: 'workshop', a: [800, 455, 1.14], b: [770, 452, 1.20], v: [1.5, 1.5] },
  { t0: 86.5, t1: 90.5, s: 'workshop', a: [770, 452, 1.20], b: [880, 458, 1.0], v: [1.5, .3] },
  { t0: 90.5, t1: 95, s: 'factory', a: [880, 460, 1.7], b: [810, 458, 1.06], v: [.3, .3] },
];
const CAPS = [
  [0.5, 4.5, 'saga · программная фабрика', 'Одна фраза въезжает в ворота завода'],
  [4.5, 8.5, 'заказ', 'FactoryRequest: от идеи до merge — по конвейеру, с доказательствами'],
  [8.5, 13.5, 'диспетчер', 'Движок зажигает цеха. Один контракт — много исполнителей'],
  [17, 21.5, 'конструкторское бюро', 'Стол аналитика: PRD собирается из точных материалов заказа'],
  [21.5, 25.5, 'гейт', 'Партия запечатана — CandidateSet. Гейт ставит клеймо'],
  [25.5, 31, 'бюро', 'SRS… UC/AC — каждый артефакт проходит свой гейт'],
  [31, 35.2, 'заморозка', 'Контракт заморожен хэшем. Дальше — только новый заказ'],
  [38, 43.5, 'рабочий стол = workplace', 'Наряд, инструменты на гвоздях, контракт под печатью, приборы'],
  [43.5, 49, 'инструменты и материалы', 'Только объявленные инструменты. Только точные входы — fence не спит'],
  [49, 52.5, 'candidate set', 'Партия запечатана дайджестом — и отдана на гейт цеха'],
  [52.5, 57.5, 'брак', 'Красный ярлык. Дефектная ведомость возвращается на тот же стол'],
  [57.5, 63.5, 'ремонт — это работа', 'Ведомость погашена: причина устранена, партия собрана заново'],
  [63.5, 68.5, 'принято', 'Зелёное клеймо. Кран-балка варит деталь в изделие — merge → main'],
  [74, 79, 'рой', 'Каждый — в своём worktree. Merge — только через кран'],
  [79, 86.5, 'run B · replay', 'Завод помнит — роботы мгновенны. ОТК не спит — гейты строги'],
  [87.5, 92, 'готово', 'ProductRevision: проверено, готово к запуску'],
];
const CARDS = [
  [0.3, 3.4, `<div class="big">ЗАВОД SAGA</div><div class="sub">программная фабрика для роя ИИ-агентов</div>`],
  [81.8, 86.2, `<div class="mid">«Завод помнит.<br>ОТК не спит.»</div>`],
  [90.8, 95.1, `<div class="big">SAGA</div><div class="sub">Devin продаёт стажёра. Saga строит завод.</div><div class="cta">git clone → npm install → node scripts/factory.mjs start</div>`],
];
const LOGS = [
  [2.5, `[factory] <b>FactoryRequest</b> «сделать продукт X» — принята`],
  [7.2, `[dispatch] наряды выданы · concurrency = min(оператор, квота)`],
  [8.5, `[workshop] Discovery: бриф принят`],
  [10.2, `[workshop] Formalization: PRD… в работе`],
  [18, `[dev] WorkerExecution#prd-1 · claim · GLM-5.3`],
  [22.3, `[gate] <b>GateDecision: accepted</b> · cs:2207`, 'ok'],
  [27, `[dev] WorkerExecution#srs-1 · claim`],
  [33, `[contract] <b>AC заморожен</b> · sha256:9f3c…a1`, 'ok'],
  [40.2, `[dev] WorkerExecution#dev-1 · claim · worktree@a41f`],
  [49, `[desk] CandidateSet cs:4471 · seal · digest 8b2f…e0`],
  [53.3, `[gate] <b>repair_required</b> → RecoveryIssue#12 «tests[3]: flux»`, 'err'],
  [58.5, `[dev] дефект погашен · revision+1 · reason-chain: new key`],
  [64.5, `[gate] <b>accepted</b> · cs:4471-r2`, 'ok'],
  [65.8, `[effect] <b>Git merge → main</b> · CAS ok`, 'ok'],
  [76, `[swarm] 6 воркеров параллельно · merge-локи без конфликтов`],
  [80.5, `[replay] капсулы: <b>HIT ×6</b> · гейты — CURRENT`],
  [88, `[factory] <b>ProductRevision v1</b> · ready-to-run`, 'ok'],
];

const Director = {
  mode: 'cine', // cine | free
  T: 0, playing: true,
  fired: new Set(),
  freeLevel: 0, // 0 завод, 1 цех, 2 стол
  freeWanted: null, // желаемый переход уровня (анимация)
  transK: 0, transFrom: null,
  seek(T) {
    this.T = clamp(T, 0, DUR); this.fired.clear();
    for (const [t] of LOGS) if (t <= this.T) this.fired.add(t);
    if (this.T >= 40) this.fired.add('desk-restart');
    // фазы стола выравниваются с режиссёрским временем
    Desk.reset(this.T >= 40 ? animClock - (this.T - 40) : animClock);
    Workshop.smoke = []; Workshop.sparks = []; Factory.smoke = [];
    this.playing = true; $('b-play').textContent = '⏸';
  },
  update(dt, animT) {
    if (this.mode === 'cine' && this.playing) {
      this.T = Math.min(this.T + dt, DUR);
      if (this.T >= DUR) this.playing = false;
    }
    const T = this.T;
    // лог
    for (const [t, h, c2] of LOGS) if (t <= T && !this.fired.has(t)) { this.fired.add(t); log(h, c2); }
    // рестарт стола под акт 3
    if (this.mode === 'cine' && T >= 40 && !this.fired.has('desk-restart')) { this.fired.add('desk-restart'); Desk.reset(animT); }
    // режим цеха и replay по акту
    if (this.mode === 'cine') {
      Workshop.mode = T < 35.5 ? 'formalization' : 'development';
      Workshop.replay = T >= 80 && T < 86.6;
    }
    // субтитры и титры
    let cap = null;
    for (const [t0, t1, k, tx] of CAPS) if (T >= t0 && T <= t1) { cap = [k, tx]; break; }
    caption(cap ? cap[0] : null, cap ? cap[1] : '');
    let cardH = null;
    for (const [t0, t1, h] of CARDS) if (T >= t0 && T <= t1) { cardH = h; break; }
    card(cardH);
    hudActs(T);
    $('prog').style.width = (T / DUR * 100) + '%';
  },
  // камера по кадрам (cine) или свободная (free)
  camAndV(animT) {
    if (this.mode === 'free') {
      const v = [0.3, 1.5, 2.7][this.freeLevel];
      return { v, cams: { factory: Factory.cam, workshop: Workshop.cam, desk: Desk.cam } };
    }
    let sh = SHOTS[0];
    for (const s of SHOTS) if (this.T >= s.t0) sh = s;
    const k = eio(clamp((this.T - sh.t0) / (sh.t1 - sh.t0), 0, 1));
    const cam = { x: lerp(sh.a[0], sh.b[0], k), y: lerp(sh.a[1], sh.b[1], k), z: lerp(sh.a[2], sh.b[2], k) };
    const v = lerp(sh.v[0], sh.v[1], k);
    if (sh.s === 'factory') Factory.cam = cam;
    else if (sh.s === 'workshop') Workshop.cam = cam;
    else Desk.cam = cam;
    return { v, cams: { factory: Factory.cam, workshop: Workshop.cam, desk: Desk.cam } };
  }
};

/* ------------------------- свободный режим ------------------------------- */
function enterFree(level, camMode) {
  Director.mode = 'free'; Director.freeLevel = level; Workshop.replay = false;
  caption(null); card(null); $('b-free').classList.add('on');
  cv.classList.add('free');
  if (camMode === 'formalization') Workshop.mode = 'formalization';
  if (camMode === 'development') { Workshop.mode = 'development'; }
  if (level === 1) Workshop.cam = { x: 800, y: 462, z: 1.05 };
  if (level === 2) Desk.cam = { x: 800, y: 480, z: 1.05 };
  if (level === 0) Factory.cam = { x: 800, y: 450, z: 1 };
}
function exitFree() {
  Director.mode = 'cine'; $('b-free').classList.remove('on'); cv.classList.remove('free');
}
let drag = null;
cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
  if (Director.mode !== 'free') return;
  const sc = sceneCam(); if (!sc) return;
  sc.cam.x -= dx / (BASE * sc.cam.z); sc.cam.y -= dy / (BASE * sc.cam.z);
  sc.cam.x = clamp(sc.cam.x, 300, 1300); sc.cam.y = clamp(sc.cam.y, 250, 650);
});
cv.addEventListener('pointerup', e => {
  const wasClick = drag && drag.moved < 6; drag = null;
  if (!wasClick) return;
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  if (Director.mode !== 'free') { enterFree(Director.T > 1.9 ? 2 : Director.T > 1.0 ? 1 : 0); return; }
  // hit-тесты
  const L = Director.freeLevel;
  if (L === 0) {
    if (wx > 430 && wx < 650 && wy > 370 && wy < 560) enterFree(1, 'formalization');
    else if (wx > 760 && wx < 1140 && wy > 350 && wy < 560) enterFree(1, 'development');
  } else if (L === 1) {
    for (const d of Workshop.desks()) {
      if (Math.abs(wx - d.x) < 80 && wy > 410 && wy < 630) {
        Desk.deskId = d.id; Desk.reset(animClock);
        if (d.kind === 'code') Desk.part = d.part === 'review' || d.part === 'verify' ? 'api.ts' : d.part;
        enterFree(2); break;
      }
    }
  }
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  if (Director.mode !== 'free') { enterFree(Director.T > 1.9 ? 2 : Director.T > 1.0 ? 1 : 0); }
  const sc = sceneCam(); if (!sc) return;
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  sc.cam.z = clamp(sc.cam.z * f, .55, 3);
  // перескоки уровней
  const L = Director.freeLevel;
  if (L === 0 && sc.cam.z > 2.3) { enterFree(1, Workshop.mode); Workshop.cam = { x: 900, y: 440, z: 1.9 }; }
  else if (L === 1 && sc.cam.z > 2.1) { enterFree(2); }
  else if (L === 1 && sc.cam.z < .72) { enterFree(0); Factory.cam = { x: 880, y: 445, z: 2.1 }; }
  else if (L === 2 && sc.cam.z < .7) { enterFree(1, Workshop.mode); Workshop.cam = { x: 800, y: 462, z: 1.9 }; }
}, { passive: false });
function sceneCam() {
  return [Factory, Workshop, Desk][Director.freeLevel];
}
function toWorld(px, py) {
  const sc = Director.mode === 'free' ? sceneCam() : null;
  const cam = sc ? sc.cam : { x: 800, y: 460, z: 1 };
  return [(px - OX) / (BASE * cam.z) + cam.x, (py - OY) / (BASE * cam.z) + cam.y];
}
document.querySelectorAll('#levels .lv').forEach((el, i) => el.addEventListener('click', () => {
  if (Director.mode !== 'free') enterFree(i); else enterFree(i);
}));
$('b-play').onclick = () => {
  if (Director.mode === 'free') exitFree();
  Director.playing = !Director.playing;
  $('b-play').textContent = Director.playing ? '⏸' : '▶';
};
$('b-restart').onclick = () => { exitFree(); Director.seek(0); Director.playing = true; $('b-play').textContent = '⏸'; logEl.innerHTML = ''; };
$('b-free').onclick = () => { if (Director.mode === 'free') { exitFree(); } else { enterFree(Director.T > 1.9 ? 2 : Director.T > 1.0 ? 1 : 0); } };
$('track').addEventListener('click', e => {
  exitFree();
  const r = e.currentTarget.getBoundingClientRect();
  Director.seek((e.clientX - r.left) / r.width * DUR);
  logEl.innerHTML = '';
  Director.fired.clear();
  for (const [t] of LOGS) if (t <= Director.T) Director.fired.add(t);
});
window.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); $('b-play').onclick(); }
  if (e.key >= 1 && e.key <= 3 && Director.mode === 'free') enterFree(+e.key - 1);
});

/* ------------------------------ главный цикл ----------------------------- */
let animClock = 0, last = performance.now();
function render() {
  const { v, cams } = Director.camAndV(animClock);
  // альфы уровней
  const aF = 1 - sm(1.00, 1.28, v);
  const aW = sm(0.98, 1.26, v) * (1 - sm(1.95, 2.25, v));
  const aD = sm(1.92, 2.22, v);
  cx.setTransform(DPR, 0, 0, DPR, 0, 0);
  cx.fillStyle = P.bg; cx.fillRect(0, 0, W, H);
  const drawScene = (scene, cam, alpha, tArg) => {
    if (alpha <= 0.002) return;
    cx.save();
    cx.translate(OX, OY); cx.scale(BASE * cam.z, BASE * cam.z); cx.translate(-cam.x, -cam.y);
    scene.draw(cx, tArg, alpha, Director.T);
    cx.restore();
  };
  drawScene(Factory, cams.factory, aF, Director.mode === 'cine' ? Director.T : animClock);
  drawScene(Workshop, cams.workshop, aW, animClock);
  if (aW > .002) { // сценарная карта заморозки — в системе координат цеха
    cx.save();
    cx.translate(OX, OY); cx.scale(BASE * cams.workshop.z, BASE * cams.workshop.z); cx.translate(-cams.workshop.x, -cams.workshop.y);
    Workshop.freezeCard(cx, Director.T);
    cx.restore();
  }
  drawScene(Desk, cams.desk, aD, animClock);
  // bloom-маска переходов
  const b1 = Math.max(0, 1 - Math.abs(v - 1.12) / .16), b2 = Math.max(0, 1 - Math.abs(v - 2.08) / .16);
  const bloom = Math.max(b1, b2);
  if (bloom > 0) {
    const g = cx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * .7);
    g.addColorStop(0, `rgba(255,233,184,${.5 * bloom})`); g.addColorStop(1, 'rgba(255,233,184,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, W, H);
  }
  cx.fillStyle = vign; cx.fillRect(0, 0, W, H);
  hudLevels(v, Director.mode === 'free', Director.freeLevel);
  hudBadges(Director.T, Workshop.replay);
}
function frame(now) {
  if (!W || !H) resize();
  const dt = Math.min((now - last) / 1000, .05); last = now;
  animClock += dt;
  Director.update(dt, animClock);
  Factory.update(dt, Director.mode === 'cine' ? Director.T : animClock);
  Workshop.update(dt, animClock);
  Desk.update(dt, animClock);
  render();
  requestAnimationFrame(frame);
}
const stillParam = new URLSearchParams(location.search).get('still');
if (stillParam !== null) {
  // статичный кадр ?still=<сек>: один рендер без rAF — для скриншотов и превью
  resize();
  Director.T = clamp(parseFloat(stillParam) || 0, 0, DUR);
  Director.playing = false;
  animClock = Director.T;
  for (const [t] of LOGS) if (t <= Director.T) Director.fired.add(t);
  if (Director.T >= 40) Director.fired.add('desk-restart');
  Desk.reset(Director.T >= 40 ? 40 : animClock);
  Factory.update(1 / 60, Director.T);
  Workshop.update(1 / 60, animClock);
  Desk.update(1 / 60, animClock);
  Director.update(0, animClock);
  render();
  // самопроверка рендера: доля закрашенных и «светящихся» пикселей → заголовок вкладки
  try {
    const pw = Math.min(Math.floor(W), 800), ph = Math.min(Math.floor(H), 600);
    const px = cx.getImageData(0, 0, pw, ph).data;
    let lit = 0, amber = 0, cyan = 0, n = 0;
    for (let i = 0; i < px.length; i += 40) {
      const r = px[i], g = px[i + 1], b = px[i + 2]; n++;
      if (px[i + 3] > 0 && (r > 8 || g > 8 || b > 8)) lit++;
      if (r > 180 && g > 110 && b < 130) amber++;
      if (b > 150 && g > 140 && r < 140) cyan++;
    }
    document.title = `still:${Director.T} fill:${(lit / n * 100).toFixed(1)}% amber:${(amber / n * 100).toFixed(2)} cyan:${(cyan / n * 100).toFixed(2)} ${W}x${H}`;
  } catch (e) { document.title = 'probe-fail ' + e.message; }
} else {
  requestAnimationFrame(frame);
}

/* debug API */
window.__demo = {
  seek(t) { exitFree(); Director.seek(t); logEl.innerHTML = ''; },
  play() { Director.playing = true; $('b-play').textContent = '⏸'; },
  pause() { Director.playing = false; $('b-play').textContent = '▶'; },
  get T() { return Director.T; },
  Workshop, Desk, Factory
};
