const LEAD_MS = 1600;
const HIT_WINDOW_MS = 180;
const MISS_GRACE_MS = 120;
const HISTORY_MS = 2000;
const MIN_VISIBILITY = 0.5;
const BANDS = [
  { label: "手区 · 用手挥", y0: 0.12, y1: 0.68, color: "#4dabf7" },
  { label: "脚区 · 用脚踢", y0: 0.68, y1: 1.0, color: "#ff9f43" },
];
const HAND_BAND = 0;
const FOOT_BAND = 1;
const HAND_POINTS = [15, 16];
const FOOT_POINTS = [27, 28];
const POINTS = [...HAND_POINTS, ...FOOT_POINTS];
const BODY_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];
const PREFERRED_CAMERA = [/dji|pocket|osmo/i, /uvc/i];

const BALL_R = 14;
const GRAVITY = 650;
const MAX_SPEED = 900;
const ITEM_R = 24;
const PICK_R = 78;
const PICK_R_FOOT = 110;
const HIT_SCORE = 10;
const BASE_W = 220;
const SPREAD_W = 170;
const WIDEN_W = 130;
const SPREAD_MIN = 0.4;
const SPREAD_MAX = 0.85;
const EFFECT_MS = 8000;
const SLOW_FACTOR = 0.6;
const LIFE_PER_ITEMS = 4;

const PP_LEFT = 150;
const PP_RIGHT = 1130;
const PP_TOP = 60;
const PP_BOTTOM = 660;
const PP_NET = 360;
const PP_PADDLE_W = 150;
const PP_AI_W = 130;
const PP_HIT_R = 130;
const PP_AI_R = 130;
const PP_AI_SPEED = 430;
const PP_BASE_VY = 560;
const PP_MAX_VY = 1150;
const PP_VX = 360;
const PP_RAMP = 1.06;
const PP_HIT_BAND = 130;
const PP_TARGET = 11;

const $ = (id) => document.getElementById(id);
const ui = {
  wrap: $("wrap"),
  cv: $("cv"),
  overlay: $("overlay"),
  game: $("game"),
  startBtn: $("startBtn"),
  fullBtn: $("fullBtn"),
  camera: $("camera"),
  bpm: $("bpm"),
  bpmV: $("bpmV"),
  offset: $("offset"),
  offsetV: $("offsetV"),
  speed: $("speed"),
  speedV: $("speedV"),
  psens: $("psens"),
  psensV: $("psensV"),
  bspeed: $("bspeed"),
  bspeedV: $("bspeedV"),
  ppspeed: $("ppspeed"),
  ppspeedV: $("ppspeedV"),
  ppswing: $("ppswing"),
  ppswingV: $("ppswingV"),
  newbie: $("newbie"),
  handsOnly: $("handsOnly"),
  skeleton: $("skeleton"),
  click: $("click"),
  score: $("score"),
  perf: $("perf"),
  diag: $("diag"),
};
const ctx = ui.cv.getContext("2d");
const W = ui.cv.width;
const H = ui.cv.height;
const video = document.createElement("video");
video.playsInline = true;
video.muted = true;
const work = document.createElement("canvas");
const wctx = work.getContext("2d");

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mode = () => ui.game.value;
const beatMs = () => 60000 / Number(ui.bpm.value);
const offsetMs = () => Number(ui.offset.value);
const speedThreshold = () => Number(ui.speed.value) / 100;
const ballTimeScale = () => Math.max(0.3, Number(ui.bspeed.value) / 100);
const handsOnly = () => ui.handsOnly.checked;
const feetAvailable = () => performance.now() - lastFeetAt < 800;
const activeBands = () => (handsOnly() || !feetAvailable() ? [HAND_BAND] : [HAND_BAND, FOOT_BAND]);
const activePoints = () => (activeBands().includes(FOOT_BAND) ? POINTS : HAND_POINTS);
const bandTop = (b) => BANDS[b].y0 * H;
const bandBottom = (b) => BANDS[b].y1 * H;

function bindLabel(input, label, fmt) {
  const update = () => { label.textContent = fmt(input.value); };
  input.addEventListener("input", update);
  update();
}
bindLabel(ui.bpm, ui.bpmV, (v) => v);
bindLabel(ui.offset, ui.offsetV, (v) => v);
bindLabel(ui.speed, ui.speedV, (v) => (v / 100).toFixed(2));
bindLabel(ui.psens, ui.psensV, (v) => (v / 100).toFixed(2));
bindLabel(ui.bspeed, ui.bspeedV, (v) => (v / 100).toFixed(2));
bindLabel(ui.ppspeed, ui.ppspeedV, (v) => (v / 100).toFixed(2));
bindLabel(ui.ppswing, ui.ppswingV, (v) => (v / 100).toFixed(2));

class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.5, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.prevT = null;
    this.x = null;
    this.dx = 0;
  }
  alpha(cutoff, dt) {
    return 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  }
  filter(x, tMs) {
    if (this.prevT === null) {
      this.prevT = tMs;
      this.x = x;
      return x;
    }
    const dt = Math.max((tMs - this.prevT) / 1000, 1e-3);
    this.prevT = tMs;
    this.dx += this.alpha(this.dCutoff, dt) * ((x - this.x) / dt - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

const filters = new Map(POINTS.map((id) => [id, { x: new OneEuro(), y: new OneEuro() }]));
const lastPts = new Map();
let hist = [];
let lastLandmarks = null;
let lastPoseAt = 0;
let lastStamp = 0;
let worker = null;
let workerReady = false;
let delegateName = "--";
let pendingFrame = false;
let camReady = false;
let camPromise = null;
let audioCtx = null;
let currentStream = null;
let newFrame = false;
let lastFeetAt = 0;
let bodyX = 0.5;

let running = false;
let lastFrameAt = 0;

let gameStart = 0;
let beat = 500;
let nextTarget = 0;
let blocks = [];
let prevCol = 1;
let score = 0;
let combo = 0;
let hits = 0;
let misses = 0;
let deltaSum = 0;
let deltaN = 0;
let lastReason = "";
let lastReasonAt = 0;

let ball = { x: W / 2, y: H * 0.32, vx: 0, vy: 0, active: false };
const platform = { x: W / 2, w: BASE_W, h: 22, y: H - 70 };
let items = [];
let spread = 0;
let widenUntil = 0;
let slowUntil = 0;
let pinScore = 0;
let pinLives = 99;
let pinHits = 0;
let pinHands = 0;
let pinFeet = 0;
let pinItems = 0;
let pinItemTimer = 0;
let pinBallTimer = 0;
let pinOver = false;
let pinMsg = "";
let pinMsgAt = 0;

let ppBall = { x: W / 2, y: PP_TOP + 60, vx: 0, vy: 0, active: false };
let ppTrail = [];
let ppAiX = W / 2;
let ppPaddleX = W / 2;
let ppPointMe = 0;
let ppPointAi = 0;
let ppRally = 0;
let ppScore = 0;
let ppServeTimer = 0;
let ppOver = false;
let ppMsg = "";
let ppMsgAt = 0;

let procMs = 0;
let frames = 0;
let fps = 0;
let fpsStart = 0;
let camInfo = "";

function setMessage(text) {
  if (ui.overlay.textContent !== text) ui.overlay.textContent = text;
}

function applyMode() {
  const m = mode();
  for (const el of document.querySelectorAll(".only-brick")) el.style.display = m === "brick" ? "" : "none";
  for (const el of document.querySelectorAll(".only-pinball")) el.style.display = m === "pinball" ? "" : "none";
  for (const el of document.querySelectorAll(".only-ping")) el.style.display = m === "pingpong" ? "" : "none";
}

function updateBodyX(lm) {
  if (!lm) return;
  const vis = (i) => (lm[i] && lm[i].visibility >= MIN_VISIBILITY ? lm[i] : null);
  const h23 = vis(23);
  const h24 = vis(24);
  const s11 = vis(11);
  const s12 = vis(12);
  let x = null;
  if (h23 && h24) x = ((1 - h23.x) + (1 - h24.x)) / 2;
  else if (s11 && s12) x = ((1 - s11.x) + (1 - s12.x)) / 2;
  if (x === null) return;
  bodyX += 0.3 * (x - bodyX);
}

function updateSpread() {
  const wl = lastPts.get(15);
  const wr = lastPts.get(16);
  const fl = lastPts.get(27);
  const fr = lastPts.get(28);
  let s = null;
  if (wl && wr) s = Math.abs(wl.x - wr.x);
  if (fl && fr) {
    const fs = Math.abs(fl.x - fr.x);
    s = s === null ? fs : Math.max(s, fs);
  }
  if (s === null) return;
  const ext = clamp((s - SPREAD_MIN) / (SPREAD_MAX - SPREAD_MIN), 0, 1);
  spread += 0.16 * (ext - spread);
}

function onPose(lm, stamp) {
  lastLandmarks = lm;
  updateBodyX(lm);
  const sample = { t: stamp, pts: {} };
  for (const id of POINTS) {
    const f = filters.get(id);
    const p = lm && lm[id];
    if (!p || p.visibility < MIN_VISIBILITY) {
      f.x.reset();
      f.y.reset();
      lastPts.delete(id);
      continue;
    }
    const x = f.x.filter(1 - p.x, stamp);
    const y = f.y.filter(p.y, stamp);
    const prev = lastPts.get(id);
    let s = 0;
    if (prev && stamp - prev.t < 200) {
      s = Math.hypot(x - prev.x, y - prev.y) / ((stamp - prev.t) / 1000);
    }
    const pt = { x, y, s, t: stamp };
    lastPts.set(id, pt);
    sample.pts[id] = pt;
  }
  if (Object.keys(sample.pts).length > 0) lastPoseAt = performance.now();
  if (sample.pts[27] || sample.pts[28]) lastFeetAt = performance.now();
  updateSpread();
  hist.push(sample);
  lastStamp = stamp;
  const cutoff = stamp - HISTORY_MS;
  while (hist.length && hist[0].t < cutoff) hist.shift();
}

function inCell(p, col, band) {
  return Math.min(2, Math.floor(p.x * 3)) === col && p.y >= BANDS[band].y0 && p.y < BANDS[band].y1;
}

function limbIds(block) {
  return block.band === FOOT_BAND ? FOOT_POINTS : HAND_POINTS;
}

function bestHit(block, off) {
  const center = block.target + off;
  const ids = limbIds(block);
  const newbie = ui.newbie.checked;
  const thr = speedThreshold();
  let best = null;
  for (const s of hist) {
    if (s.t < center - HIT_WINDOW_MS) continue;
    if (s.t > center + HIT_WINDOW_MS) break;
    const ok = ids.some((id) => {
      const p = s.pts[id];
      return p && inCell(p, block.col, block.band) && (newbie || p.s >= thr);
    });
    if (ok && (best === null || Math.abs(s.t - center) < Math.abs(best - center))) best = s.t;
  }
  return best;
}

function diagnose(block, off) {
  const center = block.target + off;
  const ids = limbIds(block);
  const newbie = ui.newbie.checked;
  const thr = speedThreshold();
  let inWindow = 0;
  let slow = 0;
  for (const s of hist) {
    if (s.t < center - HIT_WINDOW_MS) continue;
    if (s.t > center + HIT_WINDOW_MS) break;
    inWindow++;
    for (const id of ids) {
      const p = s.pts[id];
      if (p && inCell(p, block.col, block.band)) slow++;
    }
  }
  if (inWindow === 0) return "判定窗口内没有姿态样本，可能是摄像头延迟，试试调大“延迟补偿”";
  if (slow > 0 && !newbie) return "手/脚到位了但速度不够，挥动更果断，或调低“挥动速度阈值”";
  return "手/脚没进入目标格子，把对应部位送进方块所在的格子";
}

function makeBlock(target) {
  const band = activeBands().includes(FOOT_BAND) && Math.random() < 0.3 ? FOOT_BAND : HAND_BAND;
  const col = clamp(prevCol + Math.floor(Math.random() * 3) - 1, 0, 2);
  prevCol = col;
  return { target, spawn: target - LEAD_MS, band, col, state: "active", resolvedAt: 0, clicked: false };
}

function resolve(block, state, now) {
  block.state = state;
  block.resolvedAt = now;
  if (state === "hit") {
    hits++;
    combo++;
    score += 100 + Math.min(combo, 20) * 5;
  } else {
    misses++;
    combo = 0;
  }
}

function playClick() {
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = 1000;
  gain.gain.setValueAtTime(0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.05);
}

function updateBrick(now) {
  while (nextTarget - LEAD_MS <= now) {
    blocks.push(makeBlock(nextTarget));
    nextTarget += beat;
  }
  const off = offsetMs();
  for (const b of blocks) {
    if (b.state === "active" && now >= b.target + off + HIT_WINDOW_MS + MISS_GRACE_MS) {
      const t = bestHit(b, off);
      if (t === null) {
        lastReason = diagnose(b, off);
        lastReasonAt = now;
        resolve(b, "miss", now);
      } else {
        deltaSum += t - b.target;
        deltaN++;
        resolve(b, "hit", now);
      }
    }
    if (!b.clicked && now >= b.target) {
      b.clicked = true;
      if (ui.click.checked) playClick();
    }
  }
  blocks = blocks.filter((b) => now - b.target < 1000);
}

function resetBall() {
  ball.x = W * 0.5;
  ball.y = H * 0.32;
  const ang = -Math.PI / 2 + (Math.random() * 0.9 - 0.45);
  ball.vx = Math.cos(ang) * 480;
  ball.vy = Math.sin(ang) * 480;
  ball.active = true;
}

function spawnItem() {
  const type = feetAvailable() && Math.random() < 0.45 ? "foot" : "hand";
  const x = W * 0.15 + Math.random() * (W * 0.7);
  const yNorm = type === "hand" ? 0.12 + Math.random() * 0.3 : 0.62 + Math.random() * 0.23;
  items.push({ x, y: yNorm * H, type, t: 0, alive: true });
}

function stepBall(h, now) {
  ball.vy += GRAVITY * h;
  ball.x += ball.vx * h;
  ball.y += ball.vy * h;
  if (ball.x < BALL_R) { ball.x = BALL_R; ball.vx = Math.abs(ball.vx); }
  if (ball.x > W - BALL_R) { ball.x = W - BALL_R; ball.vx = -Math.abs(ball.vx); }
  if (ball.y < BALL_R) { ball.y = BALL_R; ball.vy = Math.abs(ball.vy); }
  const pTop = platform.y - platform.h / 2;
  const half = platform.w / 2;
  if (ball.vy > 0 && ball.y + BALL_R >= pTop && ball.y - BALL_R <= platform.y + platform.h / 2 && Math.abs(ball.x - platform.x) <= half + BALL_R) {
    ball.y = pTop - BALL_R;
    const off = clamp((ball.x - platform.x) / half, -1, 1);
    const speed = Math.hypot(ball.vx, ball.vy);
    const ns = clamp(speed, 480, MAX_SPEED);
    const ang = -Math.PI / 2 + off * (Math.PI / 3);
    ball.vx = Math.cos(ang) * ns;
    ball.vy = Math.sin(ang) * ns;
    pinHits++;
    pinScore += HIT_SCORE;
    pinMsg = `击球 +${HIT_SCORE}`;
    pinMsgAt = now;
  }
  const sp = Math.hypot(ball.vx, ball.vy);
  if (sp > MAX_SPEED) { ball.vx *= MAX_SPEED / sp; ball.vy *= MAX_SPEED / sp; }
}

function updatePinball(now, dt) {
  const g = Math.max(0.3, Number(ui.psens.value) / 100);
  const u = clamp((bodyX - (0.5 - g / 2)) / g, 0, 1);
  platform.w = BASE_W + spread * SPREAD_W + (now < widenUntil ? WIDEN_W : 0);
  const targetX = platform.w / 2 + u * (W - platform.w);
  platform.x += (targetX - platform.x) * Math.min(1, 18 * dt);

  pinItemTimer -= dt;
  if (pinItemTimer <= 0) {
    spawnItem();
    pinItemTimer = 1.4 + Math.random() * 1.2;
  }
  for (const it of items) {
    if (!it.alive) continue;
    const ids = it.type === "hand" ? HAND_POINTS : FOOT_POINTS;
    for (const id of ids) {
      const p = lastPts.get(id);
      const r = it.type === "hand" ? PICK_R : PICK_R_FOOT;
      if (p && Math.hypot(p.x * W - it.x, p.y * H - it.y) < r) {
        it.alive = false;
        pinItems++;
        if (it.type === "hand") {
          pinHands++;
          widenUntil = now + EFFECT_MS;
          pinMsg = "手拾取：平台加宽 8 秒";
        } else {
          pinFeet++;
          slowUntil = now + EFFECT_MS;
          pinMsg = "脚拾取：小球减速 8 秒";
        }
        if (pinItems % LIFE_PER_ITEMS === 0) {
          pinLives++;
          pinMsg += `　第 ${pinItems} 个道具：+1 命`;
        }
        pinMsgAt = now;
        break;
      }
    }
    it.t += dt;
  }
  items = items.filter((it) => it.alive && it.t < 8);

  if (ball.active) {
    const sdt = dt * ballTimeScale() * (now < slowUntil ? SLOW_FACTOR : 1);
    const steps = Math.max(1, Math.min(8, Math.ceil(sdt / 0.008)));
    const h = sdt / steps;
    for (let i = 0; i < steps; i++) stepBall(h, now);
    if (ball.y - BALL_R > H) {
      ball.active = false;
      ball.vx = 0;
      ball.vy = 0;
      pinLives--;
      if (pinLives <= 0) {
        pinOver = true;
        running = false;
        pinMsg = "游戏结束";
        pinMsgAt = now;
      } else {
        pinBallTimer = 1.2;
        pinMsg = `掉球，还剩 ${pinLives} 命`;
        pinMsgAt = now;
      }
    }
  } else if (!pinOver) {
    pinBallTimer -= dt;
    if (pinBallTimer <= 0 && pinLives > 0) resetBall();
  }
}

function drawGrid() {
  const cw = W / 3;
  ctx.lineWidth = 2;
  ctx.font = "20px sans-serif";
  for (const b of activeBands()) {
    const top = bandTop(b);
    const h = bandBottom(b) - top;
    ctx.strokeStyle = b === FOOT_BAND ? "rgba(255,159,67,0.45)" : "rgba(77,171,247,0.45)";
    for (let c = 0; c < 3; c++) ctx.strokeRect(c * cw + 6, top + 6, cw - 12, h - 12);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(BANDS[b].label, 14, top + 32);
  }
}

function drawBlocks(now) {
  const cw = W / 3;
  for (const b of blocks) {
    const cx = (b.col + 0.5) * cw;
    const cy = (bandTop(b.band) + bandBottom(b.band)) / 2;
    const base = Math.min(cw, bandBottom(b.band) - bandTop(b.band)) * 0.6;
    let scale;
    let alpha = 1;
    let color;
    if (b.state === "active") {
      scale = 0.3 + 0.7 * clamp((now - b.spawn) / (b.target - b.spawn), 0, 1);
      color = BANDS[b.band].color;
    } else {
      alpha = clamp(1 - (now - b.resolvedAt) / 400, 0, 1);
      scale = b.state === "hit" ? 1.2 : 0.8;
      color = b.state === "hit" ? "#51cf66" : "#ff6b6b";
    }
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const s = base * scale;
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

function drawPinball(now) {
  for (const it of items) {
    ctx.fillStyle = it.type === "hand" ? "#4dabf7" : "#ff9f43";
    ctx.beginPath();
    ctx.arc(it.x, it.y, ITEM_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0b0f1a";
    ctx.font = "bold 18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(it.type === "hand" ? "手" : "脚", it.x, it.y + 1);
  }
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = now < widenUntil ? "#51cf66" : "#dfe6f3";
  ctx.fillRect(platform.x - platform.w / 2, platform.y - platform.h / 2, platform.w, platform.h);
  if (ball.active) {
    ctx.fillStyle = now < slowUntil ? "#74c0fc" : "#fff";
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const id of POINTS) {
    const p = lastPts.get(id);
    if (!p) continue;
    ctx.fillStyle = HAND_POINTS.includes(id) ? "rgba(77,171,247,0.9)" : "rgba(255,159,67,0.9)";
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, 12, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSkeleton() {
  if (!ui.skeleton.checked || !lastLandmarks) return;
  const px = (p) => [(1 - p.x) * W, p.y * H];
  ctx.strokeStyle = "rgba(120,200,255,0.55)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [a, b] of BODY_CONNECTIONS) {
    const pa = lastLandmarks[a];
    const pb = lastLandmarks[b];
    if (!pa || !pb || pa.visibility < MIN_VISIBILITY || pb.visibility < MIN_VISIBILITY) continue;
    const [ax, ay] = px(pa);
    const [bx, by] = px(pb);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  for (const p of lastLandmarks) {
    if (!p || p.visibility < MIN_VISIBILITY) continue;
    const [x, y] = px(p);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTrails(now) {
  for (const s of hist) {
    const age = now - s.t;
    if (age > 300) continue;
    const a = 1 - age / 300;
    for (const id of POINTS) {
      const p = s.pts[id];
      if (!p) continue;
      ctx.globalAlpha = a * 0.8;
      ctx.fillStyle = HAND_POINTS.includes(id) ? "#4dabf7" : "#ff9f43";
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, 10 * (0.4 + 0.6 * a), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawBeat(now) {
  if (!running) return;
  const T0 = gameStart + LEAD_MS;
  const phase = (((now - T0) % beat) + beat) % beat / beat;
  ctx.globalAlpha = 1 - phase;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(60, 60, 20 + 20 * phase, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function draw(now) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (video.readyState >= 2) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
  }
  drawSkeleton();
  if (mode() === "brick") {
    drawGrid();
    drawBlocks(now);
    drawTrails(now);
    drawBeat(now);
  } else if (mode() === "pinball") {
    drawPinball(now);
  } else {
    drawPing();
  }
}

function positionText(p) {
  if (!p) return "未检测到";
  const col = Math.min(2, Math.floor(p.x * 3)) + 1;
  const band = p.y < BANDS[HAND_BAND].y1 ? "手区" : "脚区";
  return `${band}${col}列(速度 ${p.s.toFixed(2)})`;
}

function updateHud() {
  const now = performance.now();
  const age = lastStamp ? now - lastStamp : 0;
  ui.perf.textContent = `${camInfo} · 推理后端 ${delegateName} · 推理 ${procMs.toFixed(1)} ms · 样本龄 ${age.toFixed(0)} ms · ${fps} FPS`;
  if (mode() === "brick") {
    const avg = deltaN ? (deltaSum / deltaN).toFixed(0) : "--";
    ui.perf.textContent += ` · 偏移均值 ${avg} ms`;
    ui.score.textContent = `得分 ${score}  连击 ${combo}  命中 ${hits}  未命中 ${misses}`;
    const names = activeBands().includes(FOOT_BAND)
      ? [["左手", 15], ["右手", 16], ["左脚", 27], ["右脚", 28]]
      : [["左手", 15], ["右手", 16]];
    const limbs = names.map(([n, id]) => [n, lastPts.get(id)]);
    const seen = limbs.filter(([, p]) => p).length;
    const parts = limbs.map(([n, p]) => `${n} ${positionText(p)}`);
    ui.diag.textContent = `实时检测 ${seen}/${names.length} ┃ ${parts.join(" ┃ ")}`;
    if (lastReason && now - lastReasonAt < 4000) ui.diag.textContent += ` ┃ ⚠ ${lastReason}`;
    return;
  }
  if (mode() === "pingpong") {
    const h = HAND_POINTS.filter((id) => lastPts.has(id)).length;
    const f = FOOT_POINTS.filter((id) => lastPts.has(id)).length;
    ui.score.textContent = `比分 你 ${ppPointMe} : ${ppPointAi} 对手　对拉 ${ppRally} 拍　运动分 ${ppScore}`;
    ui.diag.textContent = `手 ${h}/2 脚 ${f}/2 ┃ 球速 ×${(Number(ui.ppspeed.value) / 100).toFixed(2)} ┃ 挥拍阈值 ${(Number(ui.ppswing.value) / 100).toFixed(2)}`;
    if (ppMsg && now - ppMsgAt < 2500) ui.diag.textContent += ` ┃ ${ppMsg}`;
    return;
  }
  const hands = HAND_POINTS.filter((id) => lastPts.has(id)).length;
  const feet = FOOT_POINTS.filter((id) => lastPts.has(id)).length;
  ui.score.textContent = `得分 ${pinScore}  命 ${pinLives}  击球 ${pinHits}  道具 ${pinItems}（手 ${pinHands} 脚 ${pinFeet}）`;
  const eff = [];
  if (now < widenUntil) eff.push(`加宽 ${((widenUntil - now) / 1000).toFixed(1)}s`);
  if (now < slowUntil) eff.push(`缓速 ${((slowUntil - now) / 1000).toFixed(1)}s`);
  ui.diag.textContent = `身体横向 ${(bodyX * 100).toFixed(0)}% ┃ 平台宽 ${platform.w.toFixed(0)}px ┃ 展臂 ${(spread * 100).toFixed(0)}% ┃ 手 ${hands}/2 脚 ${feet}/2`;
  if (eff.length) ui.diag.textContent += ` ┃ ${eff.join(" ")}`;
  if (pinMsg && now - pinMsgAt < 2500) ui.diag.textContent += ` ┃ ${pinMsg}`;
}

function updateOverlay(now) {
  if (!workerReady || !camReady) return;
  if (mode() === "pingpong") {
    if (ppOver) {
      setMessage(`本局结束　你 ${ppPointMe} : ${ppPointAi} 对手\n点击“开始”再来一局`);
      return;
    }
    if (!running) {
      if (now - lastPoseAt > 800) { setMessage("没看到人\n请站到画面里"); return; }
      if (!lastPts.has(15) && !lastPts.has(16)) { setMessage("没看到双手\n请站到画面里"); return; }
      setMessage(`玩法：把球拍（双手中点）移到球的横向位置并挥动来击球\n蓝色竖线对应你的双手位置，用来对照球在哪\n先到 ${PP_TARGET} 分获胜；对拉越久球越快，越打越累`);
      return;
    }
    if (now - lastPoseAt > 800) setMessage("未检测到人，请站到画面里");
    else setMessage("");
    return;
  }
  if (mode() === "brick") {
    const note = !handsOnly() && !feetAvailable() ? "\n脚部未入镜，已自动只用双手" : "";
    if (!running) {
      if (now - lastPoseAt > 800) { setMessage("没看到人\n请站到画面里"); return; }
      const need = activePoints();
      const seen = need.filter((id) => lastPts.has(id)).length;
      if (seen < need.length) {
        const what = activePoints() === HAND_POINTS ? "双手" : "双手和双脚";
        setMessage(`只看到 ${seen}/${need.length} 个部位\n请调整距离，让${what}都进入画面${note}`);
        return;
      }
      const rule = activeBands().includes(FOOT_BAND)
        ? "规则：蓝色方块用手挥、橙色方块用脚踢\n方块到达的瞬间，把对应部位送进那个格子"
        : "规则：蓝色方块用手挥\n方块到达的瞬间，把手送进那个格子";
      setMessage(`准备就绪，点击“开始”\n${rule}`);
      return;
    }
    if (now - lastPoseAt > 800) setMessage("未检测到全身，请退后让全身入镜");
    else setMessage(note.trim());
    return;
  }
  const note = !feetAvailable() ? "\n（脚部未入镜，暂不出脚部道具）" : "";
  if (pinOver) {
    setMessage(`游戏结束，得分 ${pinScore}\n点击“开始”重新来`);
    return;
  }
  if (!running) {
    if (now - lastPoseAt > 800) { setMessage("没看到人\n请站到画面里"); return; }
    if (!lastPts.has(15) && !lastPts.has(16)) { setMessage("没看到双手\n请站到画面里"); return; }
    setMessage(`玩法：身体左右移动控制底部平台，把球弹回\n接住一次 +${HIT_SCORE}；张开双臂或双腿可加宽平台\n蓝道具＝平台加宽 8 秒，橙道具＝小球减速 8 秒，每 ${LIFE_PER_ITEMS} 个道具 +1 命${note}\n站好后点击“开始”`);
    return;
  }
  if (!ball.active && now - pinMsgAt < 1200) setMessage(pinMsg);
  else if (now - lastPoseAt > 800) setMessage("未检测到人，请站到画面里");
  else setMessage("");
}

function onVideoFrame() {
  newFrame = true;
  video.requestVideoFrameCallback(onVideoFrame);
}

function frameStep() {
  const now = performance.now();
  const dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0;
  lastFrameAt = now;
  if (workerReady && newFrame && video.readyState >= 2) {
    newFrame = false;
    if (!pendingFrame) {
      wctx.drawImage(video, 0, 0, work.width, work.height);
      const ts = performance.now();
      pendingFrame = true;
      createImageBitmap(work).then(
        (bitmap) => worker.postMessage({ type: "frame", bitmap, ts }, [bitmap]),
        () => { pendingFrame = false; },
      );
    }
  }
  if (now - fpsStart >= 1000) {
    fps = frames;
    frames = 0;
    fpsStart = now;
  }
  if (running) {
    if (mode() === "brick") updateBrick(now);
    else if (mode() === "pinball") updatePinball(now, dt);
    else updatePing(now, dt);
  }
  updateOverlay(now);
  draw(now);
  updateHud();
}

function loop() {
  try {
    frameStep();
  } catch (err) {
    setMessage(`运行出错：${err.message}`);
  }
  requestAnimationFrame(loop);
}

function startWorker() {
  return new Promise((resolve, reject) => {
    worker = new Worker("./worker.js", { type: "module" });
    worker.onerror = (e) => reject(new Error(e.message || "worker 加载失败"));
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "ready") {
        delegateName = msg.delegate;
        workerReady = true;
        resolve();
      } else if (msg.type === "error") {
        reject(new Error(msg.message));
      } else if (msg.type === "pose") {
        pendingFrame = false;
        const now = performance.now();
        procMs = procMs * 0.8 + (now - msg.ts) * 0.2;
        onPose(msg.landmarks, msg.ts);
        frames++;
      }
    };
    worker.postMessage({
      type: "init",
      wasmPath: "./vendor/mediapipe/wasm",
      modelPath: "./models/pose_landmarker_lite.task",
    });
  });
}

async function openCamera(deviceId) {
  if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
  currentStream = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  const settings = currentStream.getVideoTracks()[0].getSettings();
  camInfo = `${settings.width}×${settings.height}@${Math.round(settings.frameRate || 0)}fps`;
  const vh = settings.height || video.videoHeight || 720;
  const vw = settings.width || video.videoWidth || 1280;
  work.height = Math.min(360, vh);
  work.width = Math.round(work.height * (vw / vh));
  video.srcObject = currentStream;
  await video.play();
  return settings.deviceId;
}

function pickPreferred(cams) {
  for (const re of PREFERRED_CAMERA) {
    const hit = cams.find((c) => re.test(c.label));
    if (hit) return hit.deviceId;
  }
  return null;
}

function fillCameraList(cams, selectedId) {
  ui.camera.innerHTML = "";
  cams.forEach((c, i) => {
    const opt = document.createElement("option");
    opt.value = c.deviceId;
    opt.textContent = c.label || `摄像头 ${i + 1}`;
    ui.camera.appendChild(opt);
  });
  ui.camera.value = selectedId;
}

async function setupCameras() {
  const defaultId = await openCamera(null);
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const preferred = pickPreferred(cams);
  const activeId = preferred && preferred !== defaultId ? await openCamera(preferred) : defaultId;
  fillCameraList(cams, activeId);
}

function ensureReady() {
  if (!camPromise) {
    setMessage("正在启动摄像头…");
    camPromise = (async () => {
      await setupCameras();
      camReady = true;
      setMessage("正在加载姿态模型…");
      await startWorker();
    })().then(
      () => true,
      (err) => {
        camPromise = null;
        setMessage(`启动失败：${err.message}`);
        return false;
      },
    );
  }
  return camPromise;
}

async function onCameraChange() {
  const id = ui.camera.value;
  if (!id) return;
  setMessage("切换摄像头…");
  try {
    await openCamera(id);
    setMessage("");
  } catch (err) {
    setMessage(`切换失败：${err.message}`);
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else ui.wrap.requestFullscreen();
}

function startBrick() {
  beat = beatMs();
  if (!(beat > 0)) beat = 600;
  gameStart = performance.now();
  nextTarget = gameStart + LEAD_MS;
  blocks = [];
  hist = [];
  prevCol = 1;
  score = 0;
  combo = 0;
  hits = 0;
  misses = 0;
  deltaSum = 0;
  deltaN = 0;
  running = true;
  ui.startBtn.textContent = "重新开始";
}

function startPinball() {
  pinScore = 0;
  pinLives = 99;
  pinHits = 0;
  pinHands = 0;
  pinFeet = 0;
  pinItems = 0;
  widenUntil = 0;
  slowUntil = 0;
  items = [];
  pinItemTimer = 0.8;
  pinBallTimer = 0;
  pinOver = false;
  pinMsg = "";
  platform.w = 220;
  platform.x = W / 2;
  resetBall();
  running = true;
  ui.startBtn.textContent = "重新开始";
}

function ppServe() {
  ppBall.x = PP_LEFT + 140 + Math.random() * (PP_RIGHT - PP_LEFT - 280);
  ppBall.y = PP_TOP + 70;
  ppBall.vx = (Math.random() * 2 - 1) * PP_VX * 0.6;
  ppBall.vy = PP_BASE_VY;
  ppBall.active = true;
  ppTrail = [];
}

function ppStep(h, now, thresh) {
  const b = ppBall;
  b.x += b.vx * h;
  b.y += b.vy * h;
  if (b.x < PP_LEFT) { b.x = PP_LEFT; b.vx = Math.abs(b.vx); }
  if (b.x > PP_RIGHT) { b.x = PP_RIGHT; b.vx = -Math.abs(b.vx); }

  if (b.vy > 0 && b.y >= PP_BOTTOM - PP_HIT_BAND) {
    const hl = lastPts.get(15);
    const hr = lastPts.get(16);
    const swing = Math.max(hl ? hl.s : 0, hr ? hr.s : 0);
    if (Math.abs(ppPaddleX - b.x) < PP_HIT_R && swing >= thresh) {
      const off = clamp((ppPaddleX - b.x) / PP_HIT_R, -1, 1);
      b.vy = -Math.min(PP_MAX_VY, Math.abs(b.vy) * PP_RAMP + 60);
      b.vx = off * PP_VX;
      ppRally++;
      const pts = 10 + Math.min(ppRally, 20) * 2;
      ppScore += pts;
      ppMsg = `对拉 ${ppRally} 拍　+${pts}`;
      ppMsgAt = now;
      return;
    }
    if (b.y > PP_BOTTOM + 40) {
      b.active = false;
      ppPointAi++;
      ppRally = 0;
      ppServeTimer = 1.3;
      ppMsg = "没接到，对手得分";
      ppMsgAt = now;
      if (ppPointAi >= PP_TARGET) { ppOver = true; running = false; ppMsg = "对手赢下这一局"; }
      return;
    }
  }

  if (b.vy < 0 && b.y <= PP_TOP + PP_HIT_BAND) {
    if (Math.abs(ppAiX - b.x) < PP_AI_R) {
      const off = clamp((b.x - ppAiX) / PP_AI_R, -1, 1);
      b.vy = Math.min(PP_MAX_VY, Math.abs(b.vy) * PP_RAMP + 40);
      b.vx = off * PP_VX * 0.9;
      return;
    }
    if (b.y < PP_TOP - 40) {
      b.active = false;
      ppPointMe++;
      ppScore += 40;
      ppRally = 0;
      ppServeTimer = 1.3;
      ppMsg = "对手没接到，你得分！";
      ppMsgAt = now;
      if (ppPointMe >= PP_TARGET) { ppOver = true; running = false; ppMsg = "你赢下这一局！"; }
    }
  }
}

function updatePing(now, dt) {
  const hl = lastPts.get(15);
  const hr = lastPts.get(16);
  let px = null;
  if (hl && hr) px = ((hl.x + hr.x) / 2) * W;
  else if (hl) px = hl.x * W;
  else if (hr) px = hr.x * W;
  if (px !== null) ppPaddleX += 0.3 * (px - ppPaddleX);

  if (ppBall.active && ppBall.vy < 0) {
    const step = PP_AI_SPEED * dt;
    ppAiX += clamp(ppBall.x - ppAiX, -step, step);
  }
  ppAiX = clamp(ppAiX, PP_LEFT + PP_AI_W / 2, PP_RIGHT - PP_AI_W / 2);

  if (!ppBall.active) {
    if (ppOver) return;
    ppServeTimer -= dt;
    if (ppServeTimer <= 0) ppServe();
    return;
  }

  const thresh = Number(ui.ppswing.value) / 100;
  const sdt = dt * Math.max(0.5, Number(ui.ppspeed.value) / 100);
  const steps = Math.max(1, Math.min(8, Math.ceil(sdt / 0.008)));
  const h = sdt / steps;
  for (let i = 0; i < steps; i++) ppStep(h, now, thresh);

  ppTrail.push({ x: ppBall.x, y: ppBall.y });
  if (ppTrail.length > 10) ppTrail.shift();
}

function startPing() {
  ppPointMe = 0;
  ppPointAi = 0;
  ppRally = 0;
  ppScore = 0;
  ppOver = false;
  ppMsg = "";
  ppAiX = W / 2;
  ppPaddleX = W / 2;
  ppTrail = [];
  ppBall.active = false;
  ppServeTimer = 1.0;
  running = true;
  ui.startBtn.textContent = "重新开始";
}

function drawPing() {
  ctx.fillStyle = "#0e3b2e";
  ctx.fillRect(PP_LEFT, PP_TOP, PP_RIGHT - PP_LEFT, PP_BOTTOM - PP_TOP);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 3;
  ctx.strokeRect(PP_LEFT, PP_TOP, PP_RIGHT - PP_LEFT, PP_BOTTOM - PP_TOP);
  ctx.setLineDash([14, 12]);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.moveTo(PP_LEFT, PP_NET);
  ctx.lineTo(PP_RIGHT, PP_NET);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "20px sans-serif";
  ctx.fillText("对手", PP_LEFT + 12, PP_TOP + 28);
  ctx.fillText("你", PP_LEFT + 12, PP_BOTTOM - 12);

  ctx.fillStyle = "#ff9f43";
  ctx.fillRect(ppAiX - PP_AI_W / 2, PP_TOP + 22, PP_AI_W, 16);

  ctx.strokeStyle = "rgba(77,171,247,0.5)";
  ctx.lineWidth = 2;
  for (const id of HAND_POINTS) {
    const p = lastPts.get(id);
    if (!p) continue;
    ctx.beginPath();
    ctx.moveTo(p.x * W, PP_BOTTOM - PP_HIT_BAND);
    ctx.lineTo(p.x * W, PP_BOTTOM);
    ctx.stroke();
  }

  ctx.fillStyle = "#4dabf7";
  ctx.fillRect(ppPaddleX - PP_PADDLE_W / 2, PP_BOTTOM - 46, PP_PADDLE_W, 18);

  for (let i = 0; i < ppTrail.length; i++) {
    const t = ppTrail[i];
    ctx.globalAlpha = 0.1 + 0.45 * (i / ppTrail.length);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(t.x, t.y, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (ppBall.active) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ppBall.x, ppBall.y, 12, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function onStart() {
  if (!audioCtx) audioCtx = new AudioContext();
  audioCtx.resume();
  ui.startBtn.disabled = true;
  if (!(await ensureReady())) {
    ui.startBtn.disabled = false;
    return;
  }
  ui.startBtn.disabled = false;
  running = false;
  if (mode() === "brick") startBrick();
  else if (mode() === "pinball") startPinball();
  else startPing();
}

function onModeChange() {
  running = false;
  ui.startBtn.textContent = "开始";
  applyMode();
}

ui.game.addEventListener("change", onModeChange);
ui.startBtn.addEventListener("click", onStart);
ui.fullBtn.addEventListener("click", toggleFullscreen);
ui.camera.addEventListener("change", onCameraChange);
video.requestVideoFrameCallback(onVideoFrame);
applyMode();
ensureReady();
requestAnimationFrame(loop);
