#!/usr/bin/env bash
# Sets up a full-screen kiosk on this machine (Ubuntu Server): a minimal Wayland compositor (cage)
# running Chromium on /display, started at boot, with HDMI audio so alert beeps play on the monitor.
#
# Run on the NUC itself, as a user with sudo (not root):
#   bash ~/libre3-dashboard/kiosk/setup-kiosk.sh
#
# Optional environment variables:
#   KIOSK_URL    page to show             (default: http://localhost:<HOST_PORT from .env, or 8080>/display)
#   KIOSK_USER   account the kiosk runs as (default: kiosk)
#
# Safe to re-run. Undo with:  sudo systemctl disable --now kiosk && sudo rm /etc/systemd/system/kiosk.service

set -euo pipefail

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run as a normal user with sudo, not as root."
command -v sudo >/dev/null || die "sudo is required."
command -v apt-get >/dev/null || die "This script supports Ubuntu/Debian only."

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIOSK_USER="${KIOSK_USER:-kiosk}"
PORT=8080
if [ -f "$HERE/../.env" ]; then
  p=$(grep '^HOST_PORT=' "$HERE/../.env" | tail -n1 | cut -d= -f2 | tr -cd '0-9' || true)
  if [ -n "$p" ]; then PORT=$p; fi
fi
KIOSK_URL="${KIOSK_URL:-http://localhost:$PORT/display}"
case "$KIOSK_URL" in http://* | https://*) ;; *) die "KIOSK_URL must start with http:// or https://" ;; esac
case "$KIOSK_URL" in *[[:space:]\'\"\\\$\`]*) die "KIOSK_URL contains characters that are not allowed." ;; esac
case "$KIOSK_USER" in *[!a-z0-9_-]* | "") die "KIOSK_USER may only contain a-z, 0-9, _ and -." ;; esac

say "Installing cage, audio and fonts"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  cage seatd pipewire pipewire-pulse wireplumber alsa-utils fonts-inter fonts-liberation \
  fonts-noto-color-emoji curl ca-certificates

# Chromium: Ubuntu ships it as a snap; Debian has a normal package.
CHROMIUM=""
for c in /snap/bin/chromium /usr/bin/chromium /usr/bin/chromium-browser; do
  if [ -x "$c" ]; then CHROMIUM=$c; break; fi
done
if [ -z "$CHROMIUM" ]; then
  say "Installing Chromium"
  if command -v snap >/dev/null && [ -f /etc/lsb-release ]; then
    sudo snap install chromium
    CHROMIUM=/snap/bin/chromium
  else
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium
    CHROMIUM=$(command -v chromium)
  fi
fi
[ -x "$CHROMIUM" ] || die "Could not find Chromium after installing it."

say "Creating the '$KIOSK_USER' account"
if ! id "$KIOSK_USER" >/dev/null 2>&1; then
  sudo adduser --disabled-password --gecos "Kiosk" "$KIOSK_USER"
fi
sudo usermod -aG video,audio,render,input "$KIOSK_USER" 2>/dev/null || true
sudo loginctl enable-linger "$KIOSK_USER" # keeps its audio server (PipeWire) running

KIOSK_UID=$(id -u "$KIOSK_USER")
KIOSK_HOME=$(getent passwd "$KIOSK_USER" | cut -d: -f6)

say "Writing the launcher"
sudo tee /usr/local/bin/kiosk-session >/dev/null <<LAUNCH
#!/bin/sh
# Started by kiosk.service inside a cage (Wayland) session.
export XDG_RUNTIME_DIR=/run/user/$KIOSK_UID
# Wait (up to ~2 min) for the dashboard to answer, so we never show a browser error page at boot.
i=0
while [ \$i -lt 60 ]; do
  curl -fsS -o /dev/null --max-time 3 "$KIOSK_URL" && break
  i=\$((i+1)); sleep 2
done
# Unmute and set a sensible volume; ignore failures (no audio device yet, etc).
wpctl set-mute @DEFAULT_AUDIO_SINK@ 0 2>/dev/null || true
wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.8 2>/dev/null || true
exec "$CHROMIUM" \\
  --kiosk --ozone-platform=wayland --user-data-dir=$KIOSK_HOME/chromium-profile \\
  --autoplay-policy=no-user-gesture-required \\
  --noerrdialogs --disable-infobars --no-first-run --no-default-browser-check \\
  --disable-session-crashed-bubble --hide-crash-restore-bubble \\
  --disable-features=Translate,TranslateUI --password-store=basic \\
  --overscroll-history-navigation=0 --disable-pinch \\
  "$KIOSK_URL"
LAUNCH
sudo chmod 755 /usr/local/bin/kiosk-session

say "Installing the systemd service"
sudo tee /etc/systemd/system/kiosk.service >/dev/null <<UNIT
[Unit]
Description=Glucose dashboard kiosk (cage + Chromium)
After=systemd-user-sessions.service plymouth-quit-wait.service docker.service network-online.target sound.target getty@tty1.service
Wants=network-online.target
Conflicts=getty@tty1.service

[Service]
User=$KIOSK_USER
PAMName=login
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
StandardError=journal
UtmpIdentifier=tty1
UtmpMode=user
Environment=XDG_RUNTIME_DIR=/run/user/$KIOSK_UID
Environment=WLR_LIBINPUT_NO_DEVICES=1
ExecStart=/usr/bin/cage -s -- /usr/local/bin/kiosk-session
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
UNIT

sudo systemctl daemon-reload
sudo systemctl set-default graphical.target >/dev/null
sudo systemctl enable kiosk.service >/dev/null
sudo systemctl disable --now getty@tty1.service >/dev/null 2>&1 || true

cat <<DONE

Kiosk installed. Showing: $KIOSK_URL

Start it now (or just reboot):
  sudo systemctl start kiosk

Notes:
  - Logs:           journalctl -u kiosk -f
  - Restart:        sudo systemctl restart kiosk
  - Console login:  SSH in (tty1 is used by the kiosk), or press Ctrl+Alt+F2 for a text login.
  - Sound:          HDMI audio should be picked automatically. Check with:
                      sudo -u $KIOSK_USER XDG_RUNTIME_DIR=/run/user/$KIOSK_UID wpctl status
                    then use "Test display sound" on the admin page.
  - Keep the screen awake: add consoleblank=0 to GRUB_CMDLINE_LINUX_DEFAULT in /etc/default/grub,
    then run: sudo update-grub
DONE
