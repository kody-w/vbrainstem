# The Brainstem Tether

One command that takes you from the browser brainstem (vbrainstem, running
entirely in a tab) to a full on-device brainstem — keeping your workspace.

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/kody-w/vbrainstem/main/tether.ps1 | iex
```

**macOS / Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/kody-w/vbrainstem/main/tether.sh | bash
```

## Before you run it

In the browser brainstem, ask it to **"download my workspace"**. That hits
`GET /workspace/export` and saves `brainstem-workspace-YYYY-MM-DD.zip` to your
Downloads folder. If you skip this, the tether still installs a fresh
on-device brainstem — it just starts empty.

## What the tether does

1. **Installs the real thing.** It runs the standard published installer
   (`kody-w/rapp-installer`) exactly as published — the same sacred one-liner
   everyone uses. On Windows the installer opens in a new PowerShell window;
   on macOS/Linux it runs in your terminal. The installer sets up Python, a
   venv, the brainstem source at `~/.brainstem/src/rapp_brainstem/`, walks you
   through GitHub sign-in, and launches the server on port 7071.
2. **Imports your workspace.** Once the server answers `/health`, the tether
   finds the newest `brainstem-workspace-*.zip` in Downloads (modified within
   the last 7 days), validates it (`workspace.json` must declare schema
   `rapp-workspace/1.0`), and merges it into the install. No restart needed —
   the brainstem reloads agents from disk on every request.
3. **Opens** `http://localhost:7071` in your browser.

## What moves, and what doesn't

| | |
|---|---|
| **Agents** (`agents/*.py`) | Copied in. Same-named files are overwritten (and the tether says so). `basic_agent.py` is **never** touched. |
| **Memories** (`.brainstem_data/**`) | Merged in; same-named files are overwritten. |
| **Soul** (`soul.md`) | Never clobbered. If your browser soul differs from the installed one, it is saved beside it as `soul.from-browser.md` with instructions to adopt it (`cp soul.from-browser.md soul.md` when you're ready). |
| **Tokens / credentials** | **Never move.** The browser export deliberately contains no token or session files — your GitHub credentials never leave the browser tab. On the device, you sign in **again** via the normal GitHub device-code flow during install. The tether itself never reads, prints, or writes any token file. |

## Safety properties

- **Idempotent** — run it as many times as you like. Re-runs take the
  installer's fast path and re-merge the same zip harmlessly.
- **Fail-soft** — any workspace-import problem (bad zip, missing folder,
  unreadable file) prints a warning and never blocks or aborts the install.
- **No admin/root required.** Everything lives under your home directory.
- **Bounded** — the tether waits up to 15 minutes for the install to finish,
  then tells you to run `brainstem` and re-run the tether. It never loops
  forever.

## If something goes sideways

- *"No browser workspace zip found in Downloads"* — export it from the browser
  brainstem first ("download my workspace"), then re-run the tether.
- *Server not answering* — run `brainstem` in a terminal, open
  `http://localhost:7071`, and re-run the tether to import your workspace.
- Your browser workspace zip stays in Downloads untouched — the tether only
  reads it, so you can always try again.
