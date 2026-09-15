#!/usr/bin/env bash
# Installs (or updates) SearXNG as a systemd service in WSL, listening on 127.0.0.1:8888.
# Run from Windows, inside this folder:  wsl -d Ubuntu -u root -- bash ./setup-wsl.sh [--update]
#   --update   also pull the latest SearXNG source and reinstall its Python packages
# Safe to re-run: keeps the existing secret key and only restarts the service.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARXNG_HOME=/usr/local/searxng
SRC="$SEARXNG_HOME/searxng-src"
VENV="$SEARXNG_HOME/searx-pyenv"
SETTINGS=/etc/searxng/settings.yml
URL=http://127.0.0.1:8888
UPDATE=false
[[ "${1:-}" == "--update" ]] && UPDATE=true

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root, e.g.: wsl -d Ubuntu -u root -- bash $0" >&2
  exit 1
fi
if [[ "$(ps -p 1 -o comm=)" != "systemd" ]]; then
  echo "systemd is not running. Add '[boot]' + 'systemd=true' to /etc/wsl.conf, run 'wsl --shutdown', and retry." >&2
  exit 1
fi

step() { printf '\n==> %s\n' "$*"; }
as_searxng() { sudo -H -u searxng bash -c "$1"; }

step "System packages"
export DEBIAN_FRONTEND=noninteractive
packages=(python3-dev python3-venv python3-babel git build-essential libxslt1-dev zlib1g-dev libffi-dev libssl-dev curl openssl)
missing=()
for p in "${packages[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if ((${#missing[@]})); then
  apt-get update -qq
  apt-get install -y -qq "${missing[@]}" >/dev/null
  echo "installed: ${missing[*]}"
else
  echo "all present"
fi

step "searxng user and source"
id searxng >/dev/null 2>&1 || useradd --shell /bin/bash --system --home-dir "$SEARXNG_HOME" --comment "SearXNG" searxng
mkdir -p "$SEARXNG_HOME"
chown -R searxng:searxng "$SEARXNG_HOME"
fresh=false
if [[ ! -d "$SRC/.git" ]]; then
  as_searxng "git clone -q https://github.com/searxng/searxng '$SRC'"
  fresh=true
elif $UPDATE; then
  as_searxng "git -C '$SRC' pull -q --ff-only"
fi
as_searxng "git -C '$SRC' log -1 --format='SearXNG %h (%cs)'"

step "Python environment"
if $fresh || $UPDATE || [[ ! -x "$VENV/bin/granian" ]]; then
  as_searxng "set -e
    [[ -d '$VENV' ]] || python3 -m venv '$VENV'
    . '$VENV/bin/activate'
    pip install -q -U pip setuptools wheel pyyaml msgspec typing_extensions
    cd '$SRC'
    pip install -q --use-pep517 --no-build-isolation -e .
    pip install -q -r requirements-server.txt"
  echo "packages installed"
else
  echo "up to date (use --update to upgrade)"
fi

step "Settings ($SETTINGS)"
install -d -m 755 /etc/searxng
secret=""
[[ -f "$SETTINGS" ]] && secret="$(sed -n 's/^\s*secret_key:\s*"\(.*\)"/\1/p' "$SETTINGS" | head -1)"
[[ -z "$secret" || "$secret" == "__SECRET_KEY__" ]] && secret="$(openssl rand -hex 32)"
sed "s/__SECRET_KEY__/$secret/" "$HERE/settings.yml" >"$SETTINGS.tmp"
install -m 640 -o root -g searxng "$SETTINGS.tmp" "$SETTINGS"
rm -f "$SETTINGS.tmp"
echo "written (secret key kept private, readable by root and searxng only)"

step "systemd service"
install -m 644 "$HERE/searxng.service" /etc/systemd/system/searxng.service
systemctl daemon-reload
systemctl enable searxng.service >/dev/null 2>&1
systemctl restart searxng.service

step "Health check"
for _ in $(seq 1 60); do
  if curl -fsS "$URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "$URL/healthz" >/dev/null 2>&1; then
  echo "SearXNG did not become healthy. Recent logs:" >&2
  journalctl -u searxng -n 40 --no-pager >&2
  exit 1
fi
echo "healthy at $URL"
# Engines open their first connections now; give them a few tries before judging.
count=0
for attempt in 1 2 3; do
  report="$(curl -fsS --max-time 30 "$URL/search?q=searxng+metasearch&format=json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
engines = sorted({e for r in data.get("results", []) for e in r.get("engines", [])})
problems = ", ".join(f"{name}: {reason}" for name, reason in data.get("unresponsive_engines", []))
print(len(data.get("results", [])), "results from", ", ".join(engines) or "no engines", f"(unresponsive: {problems})" if problems else "")
')"
  count="${report%% *}"
  echo "test query $attempt: $report"
  ((count > 0)) && break
  sleep 5
done
((count > 0)) || echo "WARNING: searches return no results yet. Check network access from WSL and: journalctl -u searxng -n 50" >&2
