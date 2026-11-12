# Libre Dashboard

Polls the unofficial LibreLinkUp API once a minute and stores glucose readings (mg/dL) in SQLite.
The web display, admin page and alerts come next (see `libre-dashboard-spec.md`).

## Quick install (Ubuntu/Debian, Docker)
Run as a normal user with sudo (not root):
```bash
curl -fsSL https://raw.githubusercontent.com/rgblack316/libre3-dashboard/main/install.sh | bash
```
It installs Docker if missing, downloads the app to `~/libre3-dashboard`, asks for your LibreLinkUp
follower email and password (password hidden), tests the login, and only then starts the service.
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
- The database lives in `./data` on the host (back it up from there).
- Healthy means the last poll succeeded within 10 minutes.
- The container runs as the `node` user (uid 1000), which matches the first user on Ubuntu.
  If `./data` is owned by another uid, run `sudo chown 1000:1000 data`.
- The kiosk browser stays on the host, not in the container, since it needs the display and audio.

## Tests
```bash
npm test             # runs against a local mock server, never touches Abbott
```

## Notes
- Unofficial, reverse-engineered API: it can change without notice. If logins start failing
  with an app-version error, bump `VERSION` in `src/libre.js`.
- Wrong passwords back off for 30 minutes to avoid locking the account.
- Keep the poll interval at 60s or higher to avoid rate limiting.
