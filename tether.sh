#!/usr/bin/env bash
# =============================================================================
#  Brainstem tether -- bringing your browser brainstem onto this device.
#
#  One command that takes a browser-brainstem user to a full on-device
#  brainstem, keeping their workspace (agents, memories, soul) along the way.
#
#  How it works: the published installer ends by running the server in the
#  FOREGROUND (exactly like a normal install -- Ctrl+C stops the server), so
#  this script first spawns a small background watcher that waits (bounded)
#  for http://localhost:7071/health, then imports the newest
#  brainstem-workspace-*.zip from your Downloads folder and opens the browser.
#  The installer itself runs untouched, exactly as published.
#
#  Guarantees: idempotent (safe to re-run), fail-soft (an import problem never
#  blocks the install), no root needed, and it never reads, prints, or copies
#  token files -- the browser export contains no credentials, and you sign in
#  again on-device via GitHub. macOS and Linux.
# =============================================================================

BRAINSTEM_HOME="${BRAINSTEM_HOME:-$HOME/.brainstem}"
BRAIN_DIR="$BRAINSTEM_HOME/src/rapp_brainstem"
AGENTS_DIR="$BRAIN_DIR/agents"
DATA_DIR="$BRAIN_DIR/.brainstem_data"
SOUL_PATH="$BRAIN_DIR/soul.md"
HEALTH_URL="http://localhost:7071/health"
HOME_URL="http://localhost:7071"

say() { printf '%s\n' "$*"; }

health_up() {
    curl -sf -o /dev/null --max-time 2 "$HEALTH_URL" 2>/dev/null
}

open_url() {
    case "$(uname -s 2>/dev/null)" in
        Darwin)
            open "$1" 2>/dev/null && return 0
            ;;
        *)
            if command -v xdg-open >/dev/null 2>&1; then
                xdg-open "$1" >/dev/null 2>&1 && return 0
            fi
            ;;
    esac
    # Cross-platform fallbacks, in case the idiomatic opener was missing.
    command -v open >/dev/null 2>&1 && open "$1" 2>/dev/null && return 0
    command -v xdg-open >/dev/null 2>&1 && xdg-open "$1" >/dev/null 2>&1 && return 0
    return 1
}

downloads_dir() {
    # Respect a relocated XDG download dir on Linux; default to ~/Downloads.
    if command -v xdg-user-dir >/dev/null 2>&1; then
        d=$(xdg-user-dir DOWNLOAD 2>/dev/null)
        if [ -n "$d" ] && [ -d "$d" ] && [ "$d" != "$HOME" ]; then
            printf '%s\n' "$d"
            return 0
        fi
    fi
    printf '%s\n' "$HOME/Downloads"
}

find_workspace_zip() {
    # Newest brainstem-workspace-*.zip in Downloads, modified in the last 7 days.
    dl=$(downloads_dir)
    newest=""
    for f in "$dl"/brainstem-workspace-*.zip; do
        [ -f "$f" ] || continue
        if find "$f" -maxdepth 0 -mtime -7 2>/dev/null | grep -q .; then
            if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then
                newest="$f"
            fi
        fi
    done
    printf '%s\n' "$newest"
}

extract_zip() { # $1 = zip, $2 = destination dir
    if command -v unzip >/dev/null 2>&1; then
        unzip -oq "$1" -d "$2" 2>/dev/null && return 0
    fi
    for py in python3 python; do
        if command -v "$py" >/dev/null 2>&1; then
            "$py" -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2" 2>/dev/null && return 0
        fi
    done
    # bsdtar (macOS default tar) reads zip archives too.
    tar -xf "$1" -C "$2" 2>/dev/null && return 0
    return 1
}

import_workspace() {
    # Everything in here is best-effort: any failure prints a note and moves on.
    zip_path=$(find_workspace_zip)
    if [ -z "$zip_path" ]; then
        say "  No browser workspace zip found in Downloads -- starting fresh."
        say "  (In the browser brainstem, ask it to 'download my workspace' first if you"
        say "  want your agents to come along.)"
        return 0
    fi

    say "  Found browser workspace: $(basename "$zip_path")"
    tmpdir=$(mktemp -d 2>/dev/null || printf '%s' "/tmp/brainstem-tether.$$")
    mkdir -p "$tmpdir" 2>/dev/null || { say "  [!] Could not create a temp dir -- skipping import."; return 0; }

    if ! extract_zip "$zip_path" "$tmpdir"; then
        say "  [!] Could not extract the zip (need unzip, python3, or bsdtar) -- skipping import."
        rm -rf "$tmpdir" 2>/dev/null
        return 0
    fi

    # -- Validate the manifest ------------------------------------------------
    if ! grep -q '"rapp-workspace/1.0"' "$tmpdir/workspace.json" 2>/dev/null; then
        say "  [!] workspace.json is missing or not schema 'rapp-workspace/1.0'."
        say "      This does not look like a brainstem workspace export -- skipping import."
        rm -rf "$tmpdir" 2>/dev/null
        return 0
    fi

    if [ ! -d "$BRAIN_DIR" ]; then
        say "  [!] Brainstem install not found at $BRAIN_DIR -- skipping import."
        say "      Re-run this tether after the install succeeds; it is safe to run again."
        rm -rf "$tmpdir" 2>/dev/null
        return 0
    fi

    # -- Agents ---------------------------------------------------------------
    imported=0
    overwritten=0
    if [ -d "$tmpdir/agents" ]; then
        mkdir -p "$AGENTS_DIR" 2>/dev/null
        for f in "$tmpdir"/agents/*.py; do
            [ -f "$f" ] || continue
            base=$(basename "$f")
            if [ "$base" = "basic_agent.py" ]; then
                say "    skip   basic_agent.py (never overwritten)"
                continue
            fi
            if [ -f "$AGENTS_DIR/$base" ]; then
                if cp -f "$f" "$AGENTS_DIR/$base" 2>/dev/null; then
                    imported=$((imported + 1))
                    overwritten=$((overwritten + 1))
                    say "    update $base (overwrote the existing file)"
                else
                    say "    [!] could not copy $base"
                fi
            else
                if cp "$f" "$AGENTS_DIR/$base" 2>/dev/null; then
                    imported=$((imported + 1))
                    say "    import $base"
                else
                    say "    [!] could not copy $base"
                fi
            fi
        done
    fi

    # -- Memories (.brainstem_data) -------------------------------------------
    mem=no
    if [ -d "$tmpdir/.brainstem_data" ] && [ -n "$(find "$tmpdir/.brainstem_data" -type f 2>/dev/null | head -1)" ]; then
        mkdir -p "$DATA_DIR" 2>/dev/null
        if cp -R "$tmpdir/.brainstem_data/." "$DATA_DIR/" 2>/dev/null; then
            mem=yes
        else
            say "    [!] some memory files could not be copied"
        fi
    fi

    # -- Soul (never clobbered) -------------------------------------------------
    soul_note="not present in the zip"
    if [ -f "$tmpdir/soul.md" ]; then
        side_path="$BRAIN_DIR/soul.from-browser.md"
        if [ -f "$SOUL_PATH" ]; then
            if cmp -s "$tmpdir/soul.md" "$SOUL_PATH"; then
                soul_note="identical to the installed soul.md -- nothing to do"
            else
                if cp -f "$tmpdir/soul.md" "$side_path" 2>/dev/null; then
                    soul_note="differs from the installed one -- saved as soul.from-browser.md"
                    say ""
                    say "    Your browser soul.md differs from the installed one."
                    say "    Saved it next to it as: $side_path"
                    say "    The installed soul.md was NOT changed. To adopt the browser version:"
                    say "      cp \"$side_path\" \"$SOUL_PATH\""
                else
                    soul_note="could not be saved"
                fi
            fi
        else
            if cp "$tmpdir/soul.md" "$side_path" 2>/dev/null; then
                soul_note="saved as soul.from-browser.md (no installed soul.md was found)"
            else
                soul_note="could not be saved"
            fi
        fi
    fi

    # -- Summary ----------------------------------------------------------------
    say ""
    say "  Workspace import complete: $imported agent(s) imported ($overwritten overwrote existing files); memories imported: $mem"
    say "  soul.md: $soul_note"
    rm -rf "$tmpdir" 2>/dev/null
    return 0
}

# =============================================================================
#  Main
# =============================================================================

main() {
    say ""
    say "  =============================================================="
    say "   Brainstem tether -- bringing your browser brainstem onto"
    say "   this device. Your agents and memories come along; your"
    say "   tokens never do (you will sign in again via GitHub here)."
    say "  =============================================================="
    say ""

    # Remember whether an old server was already answering, so the watcher can
    # tell "the previous server" apart from "the freshly installed one" (the
    # installer stops any old server on port 7071 before launching).
    was_up=no
    if health_up; then was_up=yes; fi

    state_dir=$(mktemp -d 2>/dev/null || printf '%s' "/tmp/brainstem-tether-state.$$")
    mkdir -p "$state_dir" 2>/dev/null
    done_file="$state_dir/import-done"
    trap 'rm -rf "$state_dir" 2>/dev/null' EXIT INT TERM

    # Background watcher: the published installer ends by running the server in
    # the foreground, so post-install steps must happen from here. Bounded wait:
    # 300 polls x 3s = 15 minutes, then give up with guidance (never loops forever).
    (
        saw_down=yes
        if [ "$was_up" = "yes" ]; then saw_down=no; fi
        ok=no
        tries=0
        while [ "$tries" -lt 300 ]; do
            if health_up; then
                if [ "$saw_down" = "yes" ]; then
                    ok=yes
                    break
                fi
                # An older server is still answering; the installer will restart it.
            else
                saw_down=yes
            fi
            tries=$((tries + 1))
            sleep 3
        done
        if [ "$ok" = "no" ] && health_up; then ok=yes; fi

        if [ "$ok" = "yes" ]; then
            say ""
            say "  -- tether: server is up, importing your browser workspace --"
            import_workspace
            say ""
            say "  -- tether: opening $HOME_URL --"
            if ! open_url "$HOME_URL"; then
                say "     (could not auto-open a browser -- visit $HOME_URL yourself)"
            fi
            say "  -- tether: done. Your on-device brainstem is running above. --"
            touch "$done_file" 2>/dev/null
        else
            say ""
            say "  [!] tether: the server at $HOME_URL never answered."
            say "      Run 'brainstem' to start it, then re-run this tether to import"
            say "      your browser workspace -- it is safe to run as many times as you like."
        fi
    ) &
    watcher_pid=$!

    say "  Running the standard installer (it may ask you to sign in to GitHub,"
    say "  and it keeps the server running in this terminal when it is done)..."
    say ""

    # The sacred one-liner, exactly as published. Do not reimplement.
    curl -fsSL https://raw.githubusercontent.com/kody-w/rapp-installer/main/install.sh | bash
    rc=$?

    # We only reach this point when the installer failed, or when the server it
    # launched has exited (e.g. Ctrl+C much later).
    if kill -0 "$watcher_pid" 2>/dev/null; then
        kill "$watcher_pid" 2>/dev/null
        wait "$watcher_pid" 2>/dev/null
        if [ ! -f "$done_file" ]; then
            say ""
            say "  [!] The installer exited (code $rc) before your workspace could be imported."
            say "      Fix any error shown above, then re-run this tether -- it is safe to"
            say "      run again, and your Downloads zip will still be picked up."
        fi
    fi
    return 0
}

main "$@"
