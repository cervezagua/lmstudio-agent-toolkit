# Local SearXNG for web-tools

A private [SearXNG](https://github.com/searxng/searxng) metasearch instance running in WSL (Ubuntu) as a systemd service. The web-tools plugin uses it by default at `http://localhost:8888`: search backend `auto`, falling back to DuckDuckGo when SearXNG isn't running.

This setup is **optional** and **Windows + WSL-specific**. On Linux or macOS, run SearXNG any way you like (its official container works) and point web-tools' **SearXNG URL** at it; enable the `json` format and turn off the limiter as described under [Settings choices](#settings-choices).

| File | Purpose |
|---|---|
| `setup-wsl.sh` | Installs or updates SearXNG, writes the settings, installs and starts the service, then runs a test search |
| `settings.yml` | Overrides of SearXNG's defaults (the secret key is generated at install time and never committed) |
| `searxng.service` | systemd unit: granian server on `127.0.0.1:8888`, running as the `searxng` user with basic hardening |
| `start-searxng.cmd` / `stop-searxng.cmd` | Windows: double-click to start or stop SearXNG |
| `start-searxng.ps1` | What the `.cmd` files run: starts the service, keeps WSL running so the port stays reachable, waits until it answers (`-Stop` to stop) |
| `autostart.ps1` | Windows: optional per-user scheduled task that runs `start-searxng.ps1` at logon (`-Remove` to undo) |

## Install

Requires WSL 2 with an Ubuntu distro that has systemd enabled (`[boot] systemd=true` in `/etc/wsl.conf`). From a terminal in this `searxng` folder:

```powershell
wsl -d Ubuntu -u root -- bash ./setup-wsl.sh
```

The script installs build packages with apt, creates a `searxng` system user, clones SearXNG into `/usr/local/searxng/searxng-src`, installs it into a virtualenv at `/usr/local/searxng/searx-pyenv`, writes `/etc/searxng/settings.yml` and enables `searxng.service`. Re-running it is safe: it keeps the secret key and restarts the service. Add `--update` to pull the latest SearXNG and reinstall its packages.

## Keeping it running

WSL stops a distro a few seconds after its last session closes, and SearXNG stops with it. After a reboot, or whenever web-tools reports `SearXNG unavailable, used DuckDuckGo`, **double-click `start-searxng.cmd`**. It starts the service, keeps WSL running in the background, and closes after a few seconds once SearXNG answers. If something fails, the window stays open with the error. `stop-searxng.cmd` stops it again.

Don't use right-click → **Run with PowerShell** on the `.ps1`. On many Windows installs that runs Windows PowerShell 5.1, whose default execution policy (Restricted) blocks every script file; the error flashes and the window closes. The `.cmd` files relax the policy for their own process only and change no system setting. From a terminal in this folder, either of these works:

```powershell
pwsh -File .\start-searxng.ps1
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-searxng.ps1
```

To start it automatically when you log in to Windows:

```powershell
pwsh -File .\autostart.ps1
```

This only registers a task for your user. It changes no global WSL settings and doesn't need admin rights. Undo it with `autostart.ps1 -Remove`.

## Settings choices

- **JSON output enabled** (`search.formats`): web-tools requests `format=json`.
- **Limiter off, not a public instance**: the limiter is anti-bot protection for public servers and would block the plugin's requests. That's safe here because the service listens only on loopback, so only your PC can reach it (WSL forwards `localhost` to Windows).
- **Engines**: chosen by testing from one Windows machine in September 2026. Brave, Bing and Google returned results; DuckDuckGo and Qwant answered with CAPTCHAs, Google CSE timed out, and Yep and PrivacyWall denied access. So DuckDuckGo and Google CSE are disabled and Bing and Google are enabled. Engines behave differently on other networks and IP addresses; to test one yourself, run:

  ```powershell
  Invoke-RestMethod "http://localhost:8888/search?q=test&format=json&engines=mojeek" | Select-Object -ExpandProperty unresponsive_engines
  ```

- **Timeouts 8 s / 15 s and IPv4 only**: on that test machine, first connections to engines took 2–3.5 s and WSL had no IPv6 route. With SearXNG's 3 s default, engines timed out right after startup and got suspended. The longer timeouts are harmless on faster connections.

## Maintenance

| Task | Command |
|---|---|
| Start / stop | double-click `start-searxng.cmd` / `stop-searxng.cmd` |
| Status | `wsl -d Ubuntu -u root -- systemctl status searxng` |
| Logs | `wsl -d Ubuntu -u root -- journalctl -u searxng -n 100 --no-pager` |
| Restart (after editing settings) | re-run `setup-wsl.sh` |
| Update SearXNG | `wsl -d Ubuntu -u root -- bash ./setup-wsl.sh --update` (from this folder) |
| Web UI | http://localhost:8888 |
| Uninstall | `wsl -d Ubuntu -u root -- bash -c "systemctl disable --now searxng; rm -rf /etc/systemd/system/searxng.service /etc/searxng /usr/local/searxng; userdel searxng"`, then `autostart.ps1 -Remove` |
