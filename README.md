# Libre Dashboard

Self-hosted FreeStyle Libre 3 dashboard. Polls the unofficial LibreLinkUp API once a minute, stores
readings (mg/dL) in SQLite, and serves:

- `/display` : kiosk view (big value, trend arrow, chart, time in range, alert banner, beeps through the monitor's speakers)
- `/admin`   : settings (thresholds, alerts, quiet hours, display, account, history, CSV export), password protected
- Alerts: urgent low / low / high / urgent high, no-data and connection-problem alerts, snooze, acknowledge, quiet hours

See `libre-dashboard-spec.md` for the design.

## Quick install (Ubuntu/Debian, Docker)
Run as a normal user with sudo (not root):
```bash
curl -fsSL https://raw.githubusercontent.com/rgblack316/libre3-dashboard/main/install.sh | bash
```
It installs Docker if missing, downloads the app to `~/libre3-dashboard`, asks for your LibreLinkUp
follower email and password (password hidden), tests the login, and only then starts the service.
At the end it prints the display and admin URLs and a generated admin password (shown once; change it in `/admin`).
You can skip the credentials prompt and enter them later on the admin page's Account tab.
Re-run the same command to update; your `.env` and `data/` are kept.

- Overrides go before `bash`, e.g. `curl -fsSL <url> | INSTALL_DIR=$HOME/glucose bash`. Available: `INSTALL_DIR`, `BRANCH`, `REPO`.
- Private repo: the raw URL needs authentication too, so download `install.sh` with a token
  (or copy it over), then run it with `GITHUB_TOKEN=<token that can read the repo> bash install.sh`.
- Your user isn't added to the `docker` group, so the script uses `sudo docker` unless you are already in it.

## Requirements
- Node.js 22.13+ (uses built-in `fetch` and `node:sqlite`; no npm dependencies).
  Ubuntu's apt `nodejs` is older, so install Node 22 from NodeSource.
- A dedicated LibreLinkUp follower account that your Libre app shares data with.

## Setup
```bash
cp .env.example .env
chmod 600 .env
nano .env            # set LLU_EMAIL and LLU_PASSWORD
npm run test-login   # logs in, lists connections, prints one reading (no secrets)
npm start            # polls every 60s and stores readings in ./data/readings.db
```

## Docker
```bash
cp .env.example .env && chmod 600 .env && nano .env   # set LLU_EMAIL and LLU_PASSWORD
mkdir -p data                                          # create it yourself so your user owns it
docker compose run --rm libre node scripts/test-login.js   # check the login first
docker compose up -d --build                           # run in the background, restarts on boot
docker compose logs -f libre                           # watch polls
docker compose ps                                      # shows healthy / unhealthy
```
- The database lives in `./data` on the host (back it up from there). Credentials saved from `/admin` are
  encrypted with `data/.secret`; back that file up with the database.
- Open `http://<host-ip>:8080/display` and `/admin`. Change the host port with `HOST_PORT` in `.env`.
- Admin password: `ADMIN_PASSWORD` in `.env` is used the first time only; if blank, one is generated and printed once in `docker compose logs libre`.
- Healthy means the web server answers; connection problems show in the UI and alerts instead.
- LAN only: do not expose the port to the internet. Docker-published ports bypass UFW rules.
- The container runs as the `node` user (uid 1000), which matches the first user on Ubuntu.
  If `./data` is owned by another uid, run `sudo chown 1000:1000 data`.
- The kiosk browser stays on the host, not in the container, since it needs the display and audio.

## Kiosk (on the NUC itself)
After the install above, run this on the NUC to boot straight into the display, with alert sound over HDMI:
```bash
bash ~/libre3-dashboard/kiosk/setup-kiosk.sh
sudo systemctl start kiosk      # or reboot
```
It installs `cage` (minimal Wayland compositor) and Chromium, creates a `kiosk` user, and runs Chromium
full screen on `/display` at boot with autoplay allowed, so beeps need no click. Logs: `journalctl -u kiosk -f`.
Text console: SSH in, or Ctrl+Alt+F2.

## Tests
```bash
npm test             # runs against a local mock server, never touches Abbott
```

## Notes
- Unofficial, reverse-engineered API: it can change without notice. If logins start failing
  with an app-version error, bump `VERSION` in `src/libre.js`.
- Wrong passwords back off for 30 minutes to avoid locking the account.
- Keep the poll interval at 60s or higher to avoid rate limiting (set in `/admin` > System).
- Behind Docker, all LAN clients may appear as one address, so a few wrong admin passwords can lock the login page for up to 15 minutes.
