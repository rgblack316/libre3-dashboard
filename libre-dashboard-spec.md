# Libre 3 Glucose Dashboard: Build Spec (v4)

## Goal
Self-hosted glucose display on a LAN-only kiosk (Intel NUC6CAYHS on a 15.6" portable monitor), running entirely on that single device, with a separate settings dashboard for management from any other device.

## Decisions
- Units: mg/dL
- Hardware: Intel NUC6CAYHS (Celeron J3455, 4 cores, x86_64) runs server and kiosk
- OS: Ubuntu Server LTS (no desktop)
- Browser: Chromium in kiosk mode via `cage` (Wayland kiosk compositor)
- Network: wired Ethernet preferred; LAN only, no Tailscale/VPN
- Alerts: high and low, configurable thresholds
- Alert sound: monitor speakers via HDMI/DP audio
- Settings: separate admin page, not shown on the kiosk display

## Hardware Notes (NUC6CAYHS)
- RAM: DDR3L SO-DIMM (up to 8GB); 4GB is plenty, 2GB works.
- Storage: SATA SSD (2.5") or M.2 SSD; 32GB+ is plenty. Much more durable than microSD.
- Video: HDMI 2.0 or DisplayPort; the portable monitor may need an HDMI cable or USB-C adapter.
- Power: ~10W TDP; fine to run 24/7. Set BIOS to power on after AC loss.
- Update BIOS before install.

## Data Source
- Unofficial LibreLinkUp API (reverse-engineered, not documented by Abbott; may break).
- Client library: `@diakem/libre-link-up-api-client` (Node) or `libre-link-unofficial-api`.
- Auth: dedicated LibreLinkUp follower account, credentials stored server-side only.
- Data: current value, trend arrow, high/low flags, timestamp, ~12h graph data, about 1 reading/min.

## Architecture (single device)
1. **Server (Node.js LTS)**
   - Poller: every 60s, re-login on session expiry, dedupe by timestamp.
   - Storage: SQLite (`node:sqlite` or `better-sqlite3`; both fine on x86_64).
   - API + static web: Express/Fastify serving `/display` and `/admin`.
   - Alert engine: evaluates each new reading against settings.
2. **Kiosk**
   - Boots to auto-login and launches `cage` + Chromium fullscreen at `http://localhost/display`.
   - Autoplay allowed (`--autoplay-policy=no-user-gesture-required`) for alert sound.
   - Screen blanking/power saving disabled; HDMI audio enabled.

## Display Page (`/display`, kiosk)
- Large current value + trend arrow, color-coded (in range / high / low / urgent low).
- Line chart (default 3h, target range band shaded).
- Time since last reading; "STALE" banner if no new reading in N minutes.
- Stats: 24h average and time-in-range.
- Active alert: full-screen color change/banner, optional beep.
- Dark theme, large text readable at a glance; no controls.
- Live updates via SSE or short polling.
- With the NUC's headroom, a charting library (e.g., uPlot or Chart.js) is fine; keep it lean regardless.

## Settings Dashboard (`/admin`)
Password-protected, opened from phone or computer, never rendered on the kiosk.

- **Thresholds (mg/dL):** low (default 70), high (default 180), urgent low (default 55), optional urgent high.
- **Alerts:** on/off per type, sound on/off, repeat interval, snooze duration, quiet hours.
- **Stale data:** minutes before warning (default 10).
- **Display:** default chart range, theme, dim schedule, show/hide stats.
- **Account:** LibreLinkUp email/password, connection test, region.
- **System:** polling interval, data retention, service status, last poll result, change admin password.
- **Data:** CSV export, readings history, alert history.
- Changes apply live; kiosk updates without a reload. Snooze/acknowledge from admin.

## Alerts
- Triggers: low, urgent low, high, urgent high, stale data, API/login failure.
- Kiosk: visual (color/banner) and optional beep through the monitor speakers.
- Repeat interval and snooze to avoid alarm fatigue; auto-clear when back in range.
- Later option: phone push via ntfy (off by default).
- Disclaimer: unofficial, delayed data; does not replace the Libre app or sensor alarms.

## Security
- Credentials in `.env` (chmod 600) or encrypted in SQLite; never in client code or git.
- Admin behind login (hashed password, session cookie); `/display` read-only.
- Bind to LAN only; no port forwarding; UFW firewall allowing only the web port and SSH.
- Server runs as a non-root systemd service; unattended security upgrades on.

## Reliability
- systemd services with auto-restart for server and kiosk.
- Nightly SQLite backup (cron) to another location on the LAN.
- DHCP reservation or static IP.
- "Disconnected" state and retry on network/API failure.
- BIOS: auto power-on after power loss.

## Risks
- Unofficial API can change or break; pin library versions.
- Keep polling at 1/min to avoid rate limiting.
- Monitor/adapter compatibility (portable monitor input and audio over HDMI): test early.

## Build Plan
1. Create the LibreLinkUp follower account; confirm login works.
2. Prototype: fetch a single reading with the Node client.
3. Poller + SQLite storage.
4. API + display page.
5. Early NUC test: install Ubuntu Server, kiosk boot, HDMI audio.
6. Settings schema + admin page (auth, thresholds, alerts).
7. Alert engine + kiosk visual/audio alerts.
8. Hardening: systemd services, firewall, backups, soak test.
