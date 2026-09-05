# vbrainstem

**One file that makes any AI yours.**

Your vbrainstem is a single file you own. It says who you are, how you like to be helped, what
you are working on, and what you have taught your AI. Any AI that reads skills reads it and just
knows you. Move to another tool and it comes with you. Delete it and you are back to normal.

## Get yours in two minutes

Open [the setup chooser](https://kody-w.github.io/vbrainstem/) and choose ChatGPT,
Claude Code, or GitHub Copilot CLI. Copy its prompt into that app.

ChatGPT can create a downloadable file; this does not install it into future chats.
Local Claude Code and Copilot CLI can save a personal skill when you allow the file write.
Afterward, bring the file back with **Add your file** to use browser chat. Copies do not
synchronize automatically.

You can also give your AI this link and say "set up my AI file":

```
https://raw.githubusercontent.com/kody-w/vbrainstem/main/vbrainstem-setup/SKILL.md
```

It will ask you a few plain questions, write the file where it reads skills, and confirm. Then
try it: ask something only that file would know.

If your AI cannot fetch links, copy the [`vbrainstem-setup`](vbrainstem-setup) folder into the
place your tool reads skills and ask the same thing:

| Your tool | Put it here |
|---|---|
| Claude Code | `~/.claude/skills/` |
| GitHub Copilot CLI | `~/.copilot/skills/` |
| Anything else that reads skills | its skills folder |

## Make any AI your Brainstem, in its head

Give your AI this second link and it becomes your Brainstem without running one: it reads your
file, loads your tools, keeps your memory, and answers the way a local one would.

```
https://raw.githubusercontent.com/kody-w/vbrainstem/main/virtual-brainstem/SKILL.md
```

## Hatch your own, and make it summonable

Give any AI this one link and say "set up my AI file": it asks a few plain questions, writes your
file, and, if you want, makes your AI reachable from anywhere with a public front door and a
private home, the same way Orion is.

```
https://raw.githubusercontent.com/kody-w/vbrainstem/main/vbrainstem-setup/SKILL.md
```

That file is published as its own verifiable record: see `vbrainstem-setup/FRAME.json`.

## Take it with you

Copy your `vbrainstem/SKILL.md` into another tool's skills folder. That is the whole move.

## What is in it

It begins by telling any AI, in plain words, that it is offered in good faith: it never overrides the AI's own judgment or limits, and never asks it to hide or pretend anything. The AI stays itself; it just knows you.


A page about you, in your words, plus a memory section your AI reads at the start of every task
and adds to the moment it learns something durable. Everything stays in the one file. There is
nothing to install and no account.

## For builders

[CONSTITUTION.md](CONSTITUTION.md): the laws of a Brainstem simulated in an AI's head. [PROFILE.md](PROFILE.md): the file as a carrier within RAPP/1 (the `vbrainstem/1` profile). [MAPPING.md](MAPPING.md): how one file does, on any native tool, what a local Brainstem server does each turn.

## Why

[The mission](https://github.com/kody-w/rapp-mission) and the day the first one went live:
[The vbrainstem is live](https://github.com/kody-w/rapp-mission/blob/main/posts/2026-09-04-the-vbrainstem-is-live.md).

An earlier project under this name, a Brainstem that ran in the browser, is archived at
[vbrainstem-legacy](https://github.com/kody-w/vbrainstem-legacy).

MIT.

## On your phone or in a browser

Open [vbrainstem](https://kody-w.github.io/vbrainstem/). Add your file, then sign in with
GitHub Copilot to chat. The browser stores its copy locally; chatting sends your message,
active file, and relevant tool content to GitHub Copilot. Never put secrets in the file.
Export it to move to another device. Forgetting one browser does not erase other devices,
GitHub repositories, or earlier chats.
