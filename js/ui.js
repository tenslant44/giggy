// =====================================================================
// UI module — screens (menu, setup, pause, settings, results), HUD,
// pop-up text, kill-feed, pose wheel and a confetti particle overlay.
// =====================================================================
import { Settings, Config, fmtTime, clamp } from './state.js';
import { POSES } from './character.js';
import { MAP_LIST } from './maps.js';
import { Audio } from './audio.js';

const $ = id => document.getElementById(id);
const SCREENS = ['menu', 'setup', 'pause', 'settings', 'results', 'loading'];

const MODE_DESC = {
  basic: 'Found Hiders are out. Hiders win if anyone survives the timer.',
  infection: 'Found Hiders turn into Seekers. Survive the growing horde!',
  double: 'Everyone hides, then everyone hunts. Most finds wins.',
  reverse: 'One Hider, everyone else races to find them first.',
};

export const UI = {
  cb: {},
  settingsReturn: 'menu',
  init(cb) {
    this.cb = cb;
    const click = (id, fn) => $(id).addEventListener('click', () => { Audio.init(); Audio.play('click'); fn(); });
    click('btnPlay', () => this.show('setup'));
    click('btnSettingsMenu', () => this.openSettings('menu'));
    click('btnSettingsPause', () => this.openSettings('pause'));
    click('btnSettingsBack', () => { Settings.save(); this.show(this.settingsReturn); });
    click('btnSetupBack', () => this.show('menu'));
    click('btnStart', () => cb.start());
    click('btnResume', () => cb.resume());
    click('btnQuit', () => cb.quit());
    click('btnNext', () => cb.next());
    click('btnResMenu', () => cb.quit());

    // setup screen
    const segMap = $('segMap');
    MAP_LIST.forEach((m, i) => { const b = document.createElement('button'); b.dataset.v = m.key; b.textContent = m.name; if (i === 0) b.classList.add('on'); segMap.appendChild(b); });
    const seg = (id, key, conv = v => v) => $(id).querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      Config[key] = conv(b.dataset.v); Audio.init(); Audio.play('click');
      if (key === 'mode') $('modeDesc').textContent = MODE_DESC[Config.mode];
    }));
    seg('segMode', 'mode'); seg('segMap', 'map'); seg('segRole', 'role'); seg('segSkill', 'skill'); seg('segSize', 'size', parseFloat);
    $('modeDesc').textContent = MODE_DESC[Config.mode];
    const range = (id, lab, key, fmt) => { const el = $(id); const u = () => { Config[key] = parseFloat(el.value); $(lab).textContent = fmt(Config[key]); }; el.addEventListener('input', u); u(); };
    range('botCount', 'botCountV', 'bots', v => v);
    range('prepTime', 'prepV', 'prepTime', v => v + 's');
    range('huntTime', 'huntV', 'huntTime', v => fmtTime(v));
    range('clones', 'clonesV', 'clones', v => v);

    // settings screen
    const sr = (id, lab, key, fmt, after) => { const el = $(id); el.value = Settings[key]; const u = () => { Settings[key] = parseFloat(el.value); $(lab).textContent = fmt(Settings[key]); after && after(); }; el.addEventListener('input', u); u(); };
    sr('sSens', 'sensV', 'sensitivity', v => v.toFixed(2));
    sr('sFov', 'fovV', 'fov', v => v + '°');
    sr('sVol', 'volV', 'volume', v => Math.round(v * 100) + '%', () => Audio.applyVolume());
    sr('sMus', 'musV', 'music', v => Math.round(v * 100) + '%', () => Audio.applyVolume());
    $('segQuality').querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.v === Settings.quality);
      b.addEventListener('click', () => { $('segQuality').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); Settings.quality = b.dataset.v; cb.quality(); Audio.play('click'); });
    });

    this.buildWheel();
    this.initConfetti();
  },
  openSettings(from) { this.settingsReturn = from; this.show('settings'); },
  show(name) {
    for (const s of SCREENS) $(s).classList.toggle('hidden', s !== name);
    $('hud').classList.toggle('hidden', !(name === null || name === 'pause' || name === 'settings' && this.settingsReturn === 'pause'));
  },
  hideAll() { for (const s of SCREENS) $(s).classList.add('hidden'); $('hud').classList.remove('hidden'); },
  current() { return SCREENS.find(s => !$(s).classList.contains('hidden')) || null; },

  // ---------- HUD ----------
  hud({ phase, timer, urgent, hiders, role, stamina, showStamina, crosshair }) {
    if (phase !== undefined) $('phaseBadge').textContent = phase;
    if (timer !== undefined) { $('timer').textContent = fmtTime(timer); $('timer').classList.toggle('urgent', !!urgent); }
    if (hiders !== undefined) $('hidersLeft').textContent = '👤 ' + hiders;
    if (role !== undefined) { const r = $('roleBadge'); r.textContent = role.toUpperCase(); r.className = 'badge big ' + (role === 'seeker' ? 'seeker' : role === 'spectator' ? 'spect' : ''); }
    if (stamina !== undefined) $('staminaFill').style.width = clamp(stamina, 0, 1) * 100 + '%';
    if (showStamina !== undefined) $('stamina').style.display = showStamina ? '' : 'none';
    if (crosshair !== undefined) { $('crosshair').style.display = crosshair ? '' : 'none'; }
  },
  crossRange(on) { $('crosshair').classList.toggle('inrange', on); },
  hint(html) { if (this._hint !== html) { $('hint').innerHTML = html; this._hint = html; $('hint').style.display = html ? '' : 'none'; } },
  stun(on) { $('stun').classList.toggle('hidden', !on); },
  waitWall(on, n) { $('waitWall').classList.toggle('hidden', !on); if (on) $('waitCount').textContent = Math.ceil(n); },
  feed(msg) {
    const d = document.createElement('div'); d.textContent = msg; $('feed').prepend(d);
    setTimeout(() => d.remove(), 5000);
    while ($('feed').children.length > 5) $('feed').lastChild.remove();
  },
  clearFeed() { $('feed').innerHTML = ''; },
  popup(text, color = '#ffd23f') {
    const p = $('popup'); p.textContent = text; p.style.color = color;
    p.classList.remove('show'); void p.offsetWidth; p.classList.add('show');
  },

  // ---------- pose wheel ----------
  buildWheel() {
    const box = $('poseItems'); box.innerHTML = '';
    this.wheelEls = POSES.map((p, i) => {
      const a = (i / POSES.length) * Math.PI * 2 - Math.PI / 2;
      const d = document.createElement('div'); d.className = 'poseItem'; d.textContent = p.name;
      d.style.left = 220 + Math.cos(a) * 160 + 'px'; d.style.top = 220 + Math.sin(a) * 160 + 'px';
      box.appendChild(d); return d;
    });
  },
  wheel: { open: false, x: 0, y: 0, sel: -1 },
  openWheel(cur) {
    this.wheel = { open: true, x: 0, y: 0, sel: -1 };
    $('poseWheel').classList.remove('hidden');
    this.wheelEls.forEach((e, i) => { e.classList.toggle('cur', POSES[i].id === cur); e.classList.remove('sel'); });
    $('poseCenter').textContent = 'POSE';
  },
  moveWheel(dx, dy, abs) {
    const w = this.wheel; if (!w.open) return;
    if (abs) { w.x = dx; w.y = dy; } else { w.x += dx; w.y += dy; }
    const l = Math.hypot(w.x, w.y);
    if (l > 120) { w.x *= 120 / l; w.y *= 120 / l; }
    let sel = -1;
    if (l > 28) { let a = Math.atan2(w.y, w.x) + Math.PI / 2; a = (a + Math.PI * 2) % (Math.PI * 2); sel = Math.round(a / (Math.PI * 2 / POSES.length)) % POSES.length; }
    if (sel !== w.sel) { w.sel = sel; this.wheelEls.forEach((e, i) => e.classList.toggle('sel', i === sel)); $('poseCenter').textContent = sel >= 0 ? POSES[sel].name : 'POSE'; if (sel >= 0) Audio.play('click'); }
  },
  closeWheel() { this.wheel.open = false; $('poseWheel').classList.add('hidden'); return this.wheel.sel >= 0 ? POSES[this.wheel.sel].id : null; },

  // ---------- results ----------
  results({ title, seekWin, sub, cards, scores }) {
    $('resTitle').textContent = title; $('resTitle').classList.toggle('seek', !!seekWin);
    $('resSub').innerHTML = sub || '';
    const box = $('resCards'); box.innerHTML = '';
    if (scores) {
      const t = document.createElement('table'); t.className = 'scoreTable';
      t.innerHTML = scores.map((s, i) => `<tr><td>${i === 0 ? '👑' : i + 1}</td><td>${s.name}</td><td style="text-align:right">${s.finds} found</td></tr>`).join('');
      box.appendChild(t);
    }
    for (const c of cards) {
      const d = document.createElement('div'); d.className = 'card ' + (c.alive ? 'alive' : 'found') + (c.me ? ' me' : '');
      d.innerHTML = `<img src="${c.img}" alt=""><div>${c.name}</div><div class="st">${c.status}</div>`;
      box.appendChild(d);
    }
    this.show('results');
  },

  // ---------- confetti ----------
  initConfetti() {
    const cv = $('confetti'), g = cv.getContext('2d');
    this.parts = [];
    const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
    resize(); addEventListener('resize', resize);
    const cols = ['#ff4f9a', '#29d3f0', '#ffd23f', '#9be34a', '#7a4cff', '#ffffff'];
    this.confetti = (x = innerWidth / 2, y = innerHeight / 2, n = 120, spread = 1) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, s = (4 + Math.random() * 10) * spread;
        this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, w: 6 + Math.random() * 8, h: 4 + Math.random() * 6, c: cols[(Math.random() * cols.length) | 0], life: 2.5 + Math.random() });
      }
    };
    let last = performance.now();
    const tick = now => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (this.parts.length || this._drew) {
        g.clearRect(0, 0, cv.width, cv.height); this._drew = this.parts.length > 0;
        for (const p of this.parts) {
          p.vy += 18 * dt * 2; p.vx *= 0.99; p.x += p.vx * dt * 60; p.y += p.vy * dt * 60 * 0.5; p.r += p.vr; p.life -= dt;
          g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.globalAlpha = Math.min(1, p.life); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2))); g.restore();
        }
        this.parts = this.parts.filter(p => p.life > 0 && p.y < cv.height + 40);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};
