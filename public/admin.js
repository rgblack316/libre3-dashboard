// Admin page: sign-in, settings forms, account, status and export.
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const ALERT_NAMES = {
    urgent_low: 'Urgent low', low: 'Low', high: 'High', urgent_high: 'Urgent high', no_data: 'No data',
  };
  const TREND_TEXT = { 5: 'rising fast', 4: 'rising', 3: 'steady', 2: 'falling', 1: 'falling fast' };

  let settings = null;
  let statusTimer = null;

  // ---- helpers ------------------------------------------------------------------------------

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (res.status === 401 && path !== '/api/admin/login') {
      showLogin();
      throw new Error('Please sign in again');
    }
    if (!res.ok) {
      const err = new Error(data?.error ?? `Request failed (${res.status})`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function say(el, text, kind) {
    el.textContent = text ?? '';
    el.classList.toggle('ok', kind === 'ok');
    el.classList.toggle('err', kind === 'err');
  }

  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    o[keys.at(-1)] = value;
  }

  const fmtTime = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function ago(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} days ago`;
  }

  function fillKv(dl, rows) {
    dl.replaceChildren();
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      dl.append(dt, dd);
    }
  }

  // ---- sign in / out ------------------------------------------------------------------------

  function showLogin() {
    clearInterval(statusTimer);
    $('#main').hidden = true;
    $('#login').hidden = false;
    $('#loginPw').focus();
  }

  async function showMain() {
    $('#login').hidden = true;
    $('#main').hidden = false;
    await Promise.all([loadSettings(), loadAccount(), refreshStatus()]);
    clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      if (!document.hidden && !$('[data-panel="status"]').hidden) refreshStatus().catch(() => {});
    }, 10_000);
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#loginMsg');
    say(msg, '');
    try {
      await api('POST', '/api/admin/login', { password: $('#loginPw').value });
      $('#loginPw').value = '';
      await showMain();
    } catch (err) {
      say(msg, err.message, 'err');
    }
  });

  $('#logout').addEventListener('click', async () => {
    try {
      await api('POST', '/api/admin/logout');
    } catch {
      /* already signed out */
    }
    showLogin();
  });

  // ---- tabs ---------------------------------------------------------------------------------

  function openTab(name) {
    for (const b of $$('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== name;
    history.replaceState(null, '', `#${name}`);
    if (name === 'status') refreshStatus().catch(() => {});
    if (name === 'system' || name === 'data') refreshStatus().catch(() => {});
  }
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) openTab(b.dataset.tab);
  });

  // ---- settings forms -----------------------------------------------------------------------

  function fillSettings(s) {
    for (const el of $$('[data-path]')) {
      const v = getPath(s, el.dataset.path);
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = v === undefined || v === null ? '' : String(v);
    }
  }

  function collect(form) {
    const out = {};
    for (const el of $$('[data-path]', form)) {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'number' || el.dataset.kind === 'int') v = el.value === '' ? null : Number(el.value);
      else v = el.value.trim();
      setPath(out, el.dataset.path, v);
    }
    return out;
  }

  function clearErrors(form) {
    for (const el of $$('.field-error', form)) el.remove();
    for (const el of $$('.invalid', form)) el.classList.remove('invalid');
  }

  async function loadSettings() {
    const data = await api('GET', '/api/admin/settings');
    settings = data.settings;
    fillSettings(settings);
  }

  for (const form of $$('[data-settings-form]')) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('[data-save-msg]', form);
      clearErrors(form);
      say(msg, 'Saving…');
      try {
        const data = await api('PUT', '/api/admin/settings', collect(form));
        settings = data.settings;
        fillSettings(settings);
        say(msg, 'Saved. The display has been updated.', 'ok');
      } catch (err) {
        const errors = err.data?.errors ?? [];
        let shown = 0;
        for (const { field, message } of errors) {
          const el = $(`[data-path="${field}"]`, form);
          if (!el) continue;
          el.classList.add('invalid');
          const note = document.createElement('div');
          note.className = 'field-error';
          note.textContent = message;
          el.insertAdjacentElement('afterend', note);
          shown += 1;
        }
        const other = errors.filter((x) => !$(`[data-path="${x.field}"]`, form));
        say(msg, shown && !other.length ? 'Please fix the highlighted fields.' : (other[0]?.message ?? err.message), 'err');
      }
    });
  }

  // ---- account ------------------------------------------------------------------------------

  async function loadAccount() {
    const a = await api('GET', '/api/admin/account');
    $('#accEmail').value = a.email;
    $('#accRegion').value = a.region;
    $('#accPassword').value = '';
    $('#accSource').textContent = {
      admin: 'Using the account saved on this page.',
      env: 'Using the account from the .env file. Saving here replaces it.',
      none: 'No account is set up yet.',
    }[a.source] ?? '';
  }

  $('#accTest').addEventListener('click', async () => {
    const msg = $('#accMsg');
    say(msg, 'Testing…');
    try {
      const r = await api('POST', '/api/admin/test-login', {
        email: $('#accEmail').value,
        password: $('#accPassword').value,
        region: $('#accRegion').value,
      });
      if (r.ok) {
        const who = r.patient ? ` Following ${r.patient}.` : '';
        say(msg, r.connections ? `Login works.${who}` : 'Login works, but no one is sharing data with this account yet.', r.connections ? 'ok' : 'err');
      } else {
        say(msg, `Login failed: ${r.error.message}`, 'err');
      }
    } catch (err) {
      say(msg, err.message, 'err');
    }
  });

  $('#accountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#accMsg');
    say(msg, 'Saving…');
    try {
      await api('PUT', '/api/admin/account', {
        email: $('#accEmail').value,
        password: $('#accPassword').value,
        region: $('#accRegion').value,
      });
      say(msg, 'Saved. Checking for readings now.', 'ok');
      await loadAccount();
      setTimeout(() => refreshStatus().catch(() => {}), 2500);
    } catch (err) {
      say(msg, err.message, 'err');
    }
  });

  $('#passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#pwMsg');
    say(msg, 'Saving…');
    try {
      await api('POST', '/api/admin/password', { current: $('#pwCurrent').value, next: $('#pwNew').value });
      $('#pwCurrent').value = '';
      $('#pwNew').value = '';
      say(msg, 'Password changed. Other sessions were signed out.', 'ok');
    } catch (err) {
      say(msg, err.message, 'err');
    }
  });

  // ---- status -------------------------------------------------------------------------------

  async function refreshStatus() {
    const [st, al] = await Promise.all([api('GET', '/api/admin/status'), api('GET', '/api/admin/alerts?limit=30')]);
    const now = st.now;

    $('#nowValue').textContent = st.current ? String(st.current.value) : '--';
    $('#nowText').textContent = st.current
      ? `mg/dL${st.current.trendLabel ? `, ${TREND_TEXT[st.current.trend] ?? st.current.trendLabel}` : ''} · ${ago(st.current.ts, now)} (${fmtTime(st.current.ts)})`
      : 'No readings yet.';

    const a = st.alert;
    const parts = [];
    if (a.active) parts.push(`Active alert: ${ALERT_NAMES[a.active] ?? a.active}`);
    else parts.push('No active alert.');
    if (a.acknowledged) parts.push('Sound acknowledged.');
    if (a.snoozedUntil) parts.push(`Sound snoozed until ${fmtTime(a.snoozedUntil)}.`);
    $('#alertText').textContent = parts.join(' ');

    const lp = st.lastPoll;
    fillKv($('#connInfo'), [
      ['Account', { admin: 'Saved on this page', env: 'From .env file', none: 'Not set up' }[st.credsSource]],
      ['Last check', lp ? `${lp.ok ? 'OK' : `Failed (${lp.code}): ${lp.message}`} · ${ago(lp.at, now)}` : 'Not yet'],
      ['Failed checks in a row', String(st.failures)],
      ['Check interval', `${st.pollSeconds} s`],
      ['Displays connected', String(st.displays)],
    ]);

    const tbody = $('#alertTable tbody');
    tbody.replaceChildren();
    if (!al.alerts.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = 'No alerts yet.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    for (const row of al.alerts) {
      const tr = document.createElement('tr');
      const name = row.kind === 'glucose' ? (ALERT_NAMES[row.level] ?? row.level)
        : row.kind === 'stale' ? 'No new data'
          : `LibreLinkUp problem${row.level ? ` (${row.level})` : ''}`;
      for (const text of [fmtTime(row.ts), name, row.event === 'start' ? 'Started' : 'Ended', row.value ?? '']) {
        const td = document.createElement('td');
        td.textContent = String(text);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    fillKv($('#sysInfo'), [
      ['Version', st.version],
      ['Running since', fmtTime(st.startedAt)],
      ['Readings stored', st.readings.toLocaleString()],
      ['Database size', st.dbBytes == null ? 'n/a' : `${(st.dbBytes / 1048576).toFixed(1)} MB`],
      ['Time zone', st.timezone],
    ]);
    $('#dataInfo').textContent = `${st.readings.toLocaleString()} readings stored.`;
  }

  async function action(path, body, okText) {
    const msg = $('#statusMsg');
    say(msg, '');
    try {
      const r = await api('POST', path, body);
      say(msg, typeof okText === 'function' ? okText(r) : okText, 'ok');
      await refreshStatus();
    } catch (err) {
      say(msg, err.message, 'err');
    }
  }

  $('#btnSnooze').addEventListener('click', () => action('/api/admin/snooze', { minutes: Number($('#snoozeMinutes').value) }, 'Sound snoozed.'));
  $('#btnClearSnooze').addEventListener('click', () => action('/api/admin/snooze/clear', {}, 'Snooze cleared.'));
  $('#btnAck').addEventListener('click', () => action('/api/admin/ack', {}, 'Alert acknowledged. Sound is off until the alert changes.'));
  $('#btnBeep').addEventListener('click', () =>
    action('/api/admin/test-beep', {}, (r) => (r.displays ? `Sent to ${r.displays} display(s).` : 'No display is connected right now.')));
  $('#btnPoll').addEventListener('click', () => action('/api/admin/poll-now', {}, 'Checked.'));

  // ---- export -------------------------------------------------------------------------------

  function updateExportLink() {
    const params = new URLSearchParams();
    const from = $('#expFrom').value;
    const to = $('#expTo').value;
    if (from) params.set('from', String(new Date(`${from}T00:00:00`).getTime()));
    if (to) params.set('to', String(new Date(`${to}T23:59:59.999`).getTime()));
    const q = params.toString();
    $('#expLink').href = `/api/admin/export.csv${q ? `?${q}` : ''}`;
  }
  $('#expFrom').addEventListener('change', updateExportLink);
  $('#expTo').addEventListener('change', updateExportLink);

  // ---- start --------------------------------------------------------------------------------

  (async () => {
    try {
      const s = await api('GET', '/api/admin/session');
      if (s.authenticated) {
        await showMain();
        const tab = location.hash.slice(1);
        if (tab && $(`[data-tab="${tab}"]`)) openTab(tab);
      } else {
        showLogin();
      }
    } catch {
      showLogin();
    }
  })();
})();
