// Kiosk display: shows the current reading, trend, chart, stats and alerts.
// Live updates arrive over server-sent events; everything is drawn with plain DOM/SVG.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Libre arrows: 5 rising fast (up) ... 3 steady (right) ... 1 falling fast (down).
  const TREND_ANGLE = { 5: -90, 4: -45, 3: 0, 2: 45, 1: 90 };
  const TREND_TEXT = { 5: 'rising fast', 4: 'rising', 3: 'steady', 2: 'falling', 1: 'falling fast' };
  const LABELS = {
    urgent_low: 'Urgent low', low: 'Low', in: 'In range', high: 'High', urgent_high: 'Urgent high', nodata: 'No data',
  };
  const GAP_MS = 20 * 60_000; // break the chart line across gaps longer than this

  let state = null;
  let clockOffset = 0; // server time minus this browser's time
  let lastContact = 0;
  let bootId = null;
  let readings = [];
  let statsAt = 0;
  let statsKey = '';
  let audio = null;

  const nowMs = () => Date.now() + clockOffset;
  const timeFmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function levelOf(v, t) {
    if (v < t.urgentLow) return 'urgent_low';
    if (v < t.low) return 'low';
    if (v > t.urgentHigh) return 'urgent_high';
    if (v > t.high) return 'high';
    return 'in';
  }

  async function getJson(path) {
    const res = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---- rendering ----------------------------------------------------------------------------

  function bannerText(s, ageMin) {
    const a = s.alert;
    if (!a.active) return null;
    let head = LABELS[a.active] ?? a.active;
    let detail = '';
    if (a.active === 'no_data') {
      if (a.apiError) {
        head = a.apiError.code === 'NOT_CONFIGURED' ? 'Not set up' : 'No data';
        detail = {
          NOT_CONFIGURED: 'Add the LibreLinkUp account on the admin page.',
          BAD_CREDENTIALS: 'LibreLinkUp login failed. Check the account on the admin page.',
          LOGIN_FAILED: 'LibreLinkUp login failed. Check the account on the admin page.',
          NO_CONNECTION: 'No LibreLinkUp connection found. Share your data to the follower account.',
          NETWORK: "Can't reach LibreLinkUp.",
          RATE_LIMIT: 'LibreLinkUp is limiting requests. Retrying later.',
        }[a.apiError.code] ?? `LibreLinkUp error: ${a.apiError.message}`;
      } else {
        detail = ageMin === null ? 'No readings yet.' : `No new reading for ${ageMin} min.`;
      }
    }
    const notes = [];
    if (a.acknowledged) notes.push('sound acknowledged');
    else if (a.snoozedUntil) notes.push(`sound snoozed until ${timeFmt(a.snoozedUntil)}`);
    const small = [detail, notes.join(', ')].filter(Boolean).join(' · ');
    return { head, small };
  }

  function render() {
    if (!state) return;
    const cur = state.current;
    const age = cur ? Math.max(0, nowMs() - cur.ts) : null;
    const ageMin = age === null ? null : Math.floor(age / 60_000);
    const stale = !cur || age > state.staleMinutes * 60_000;
    const level = cur && !stale ? levelOf(cur.value, state.thresholds) : 'nodata';

    app.dataset.level = level;
    app.dataset.alert = state.alert.active ?? '';
    app.classList.toggle('stale', stale);
    app.classList.toggle('no-chart', !state.display.showChart);
    app.classList.toggle('no-stats', !state.display.showStats);
    document.documentElement.dataset.theme = state.display.theme;
    $('dim').style.opacity = String(Math.max(0, Math.min(0.9, 1 - state.display.dimLevel / 100)));

    $('value').textContent = cur ? String(cur.value) : '--';
    $('label').textContent = LABELS[level];

    const arrow = $('arrow');
    if (cur && cur.trend && TREND_ANGLE[cur.trend] !== undefined) {
      arrow.hidden = false;
      $('arrowGroup').style.transform = `rotate(${TREND_ANGLE[cur.trend]}deg)`;
      $('trendText').textContent = TREND_TEXT[cur.trend];
    } else {
      arrow.hidden = true;
      $('trendText').textContent = '';
    }

    $('age').textContent = !cur
      ? 'Waiting for the first reading'
      : `${ageMin < 1 ? 'Just now' : `${ageMin} min ago`} · ${timeFmt(cur.ts)}`;

    const banner = $('banner');
    const text = bannerText(state, ageMin);
    banner.hidden = !text;
    if (text) {
      banner.replaceChildren(document.createTextNode(text.head));
      if (text.small) {
        const small = document.createElement('small');
        small.textContent = text.small;
        banner.appendChild(small);
      }
    }

    $('conn').hidden = Date.now() - lastContact < 45_000;
    drawChart();
  }

  // ---- chart --------------------------------------------------------------------------------

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function drawChart() {
    if (!state || !state.display.showChart) return;
    const svg = $('chartsvg');
    const box = $('chart').getBoundingClientRect();
    const W = Math.max(320, Math.floor(box.width));
    const H = Math.max(160, Math.floor(box.height));
    if (!box.width || !box.height) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();

    const t = state.thresholds;
    const hours = state.display.chartHours;
    const x1 = nowMs();
    const x0 = x1 - hours * 3_600_000;
    const pts = readings.filter((r) => r.ts >= x0 && r.ts <= x1 + 60_000);
    const vals = pts.map((p) => p.value);

    const yMin = Math.max(30, Math.floor(Math.min(40, ...vals.map((v) => v - 10)) / 10) * 10);
    const yMax = Math.min(450, Math.ceil(Math.max(t.high + 40, ...vals.map((v) => v + 10)) / 10) * 10);
    const fs = Math.max(12, Math.round(H / 16));
    const pad = { l: fs * 2.6, r: fs * 0.8, t: fs * 0.6, b: fs * 1.7 };
    const X = (ms) => pad.l + ((ms - x0) / (x1 - x0)) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

    // target band + horizontal grid
    svg.appendChild(svgEl('rect', { class: 'c-band', x: pad.l, y: Y(t.high), width: W - pad.l - pad.r, height: Math.max(0, Y(t.low) - Y(t.high)) }));
    for (let v = Math.ceil(yMin / 50) * 50; v <= yMax; v += 50) {
      svg.appendChild(svgEl('line', { class: 'c-grid', x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v) }));
      svg.appendChild(svgEl('text', { class: 'c-text', x: pad.l - 8, y: Y(v) + fs * 0.35, 'text-anchor': 'end', 'font-size': fs }, String(v)));
    }
    svg.appendChild(svgEl('line', { class: 'c-thr c-thr-high', x1: pad.l, x2: W - pad.r, y1: Y(t.high), y2: Y(t.high) }));
    svg.appendChild(svgEl('line', { class: 'c-thr c-thr-low', x1: pad.l, x2: W - pad.r, y1: Y(t.low), y2: Y(t.low) }));

    // hour ticks
    const stepH = hours <= 3 ? 1 : hours <= 6 ? 1 : hours <= 12 ? 2 : 4;
    const first = new Date(x0);
    first.setMinutes(0, 0, 0);
    for (let ts = first.getTime() + 3_600_000; ts < x1; ts += 3_600_000) {
      if (new Date(ts).getHours() % stepH !== 0) continue;
      svg.appendChild(svgEl('line', { class: 'c-grid', x1: X(ts), x2: X(ts), y1: pad.t, y2: H - pad.b }));
      const label = new Date(ts).toLocaleTimeString([], { hour: 'numeric' });
      svg.appendChild(svgEl('text', { class: 'c-text', x: X(ts), y: H - pad.b + fs * 1.25, 'text-anchor': 'middle', 'font-size': fs }, label));
    }

    if (!pts.length) return;

    // line, broken across long gaps
    let d = '';
    let prev = null;
    for (const p of pts) {
      d += `${prev && p.ts - prev.ts <= GAP_MS ? 'L' : 'M'}${X(p.ts).toFixed(1)} ${Y(p.value).toFixed(1)} `;
      prev = p;
    }
    svg.appendChild(svgEl('path', { class: 'c-line', d }));

    // dots coloured by range
    const dot = Math.max(2.5, Math.min(5, W / pts.length / 2.2));
    for (const p of pts) {
      svg.appendChild(svgEl('circle', { class: `pt-${levelOf(p.value, t)}`, cx: X(p.ts).toFixed(1), cy: Y(p.value).toFixed(1), r: dot }));
    }
    const last = pts[pts.length - 1];
    svg.appendChild(svgEl('circle', { class: 'c-last', cx: X(last.ts).toFixed(1), cy: Y(last.value).toFixed(1), r: dot * 2 }));
  }

  // ---- data ---------------------------------------------------------------------------------

  async function refreshReadings() {
    try {
      const data = await getJson(`/api/readings?hours=${state.display.chartHours}&maxPoints=700`);
      readings = data.readings;
      drawChart();
    } catch {
      /* keep what we have */
    }
  }

  async function refreshStats(force) {
    if (!state || !state.display.showStats) return;
    const key = `${state.thresholds.low}|${state.thresholds.high}`;
    if (!force && key === statsKey && Date.now() - statsAt < 5 * 60_000) return;
    try {
      const { stats } = await getJson('/api/stats?range=24h');
      statsAt = Date.now();
      statsKey = key;
      renderStats(stats);
    } catch {
      /* keep what we have */
    }
  }

  function renderStats(s) {
    if (!s) {
      $('statAvg').textContent = '--';
      $('statRange').textContent = '--';
      $('tirText').textContent = '--';
      for (const id of ['tirLow', 'tirIn', 'tirHigh']) $(id).style.width = '0%';
      return;
    }
    $('statAvg').textContent = String(s.avg);
    $('statRange').textContent = `${s.min}–${s.max}`;
    $('tirLow').style.width = `${s.tir.below}%`;
    $('tirIn').style.width = `${s.tir.inRange}%`;
    $('tirHigh').style.width = `${s.tir.above}%`;
    $('tirText').textContent = `${Math.round(s.tir.inRange)}% in range · ${Math.round(s.tir.below)}% low · ${Math.round(s.tir.above)}% high`;
  }

  function onState(s) {
    if (bootId !== null && s.startedAt !== bootId) {
      location.reload(); // server restarted (maybe updated): pick up fresh page code
      return;
    }
    bootId = s.startedAt;
    clockOffset = s.serverNow - Date.now();
    const prev = state;
    state = s;
    const newReading = !prev || prev.current?.ts !== s.current?.ts || prev.display.chartHours !== s.display.chartHours;
    render();
    if (newReading) refreshReadings();
    refreshStats(false);
  }

  // ---- sound --------------------------------------------------------------------------------

  function ensureAudio() {
    if (audio) return audio;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audio = new Ctx();
    return audio;
  }

  function updateSoundBadge() {
    $('soundBadge').hidden = !audio || audio.state === 'running';
  }

  function playBeep(severity) {
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const pattern = severity === 'urgent'
      ? [988, 988, 988, 988].map((f) => ({ f, d: 0.16 }))
      : [660, 660].map((f) => ({ f, d: 0.26 }));
    let t = ctx.currentTime + 0.05;
    for (const p of pattern) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = p.f;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.5, t + 0.02);
      gain.gain.linearRampToValueAtTime(0, t + p.d);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + p.d + 0.03);
      t += p.d + 0.12;
    }
    setTimeout(updateSoundBadge, 400);
  }

  $('soundBadge').addEventListener('click', () => {
    const ctx = ensureAudio();
    if (ctx) ctx.resume().then(updateSoundBadge).catch(() => {});
  });

  // ---- start --------------------------------------------------------------------------------

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (e) => {
      lastContact = Date.now();
      onState(JSON.parse(e.data));
    });
    es.addEventListener('ping', () => {
      lastContact = Date.now();
    });
    es.addEventListener('beep', (e) => {
      lastContact = Date.now();
      playBeep(JSON.parse(e.data).severity);
    });
    // EventSource reconnects by itself; the "lost connection" notice appears if it takes too long.
  }

  window.addEventListener('resize', drawChart);
  setInterval(render, 10_000); // keeps "x min ago" and the connection notice current
  lastContact = Date.now();
  ensureAudio();
  setTimeout(updateSoundBadge, 1500);
  connect();
})();
