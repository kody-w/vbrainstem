---
name: "vbrainstem-setup"
description: "Set up a person's own AI file, their vbrainstem: one file that makes any AI theirs, carrying who they are, how they like to be helped, what they are working on, and what they teach it over time. Use when someone says they want their AI to know them, wants to get started, wants their AI settings to follow them to another tool, or asks what a vbrainstem is."
license: "MIT"
compatibility: "Any AI that reads skills and can write a file. Nothing to install."
metadata:
  source: "setup"
---

# Set up your vbrainstem

A vbrainstem is one file you own. It makes any AI yours: who you are, how you like to be helped,
what you are working on, and what you have taught your AI. Any AI that reads skills reads it.
Move to another tool and it comes with you. Delete it and you are back to normal.

Follow these steps for the person. Speak plainly. Never use a term they would have to look up.

## 1. Check first

Look for an existing file at the place this AI reads personal skills, in a folder named
`vbrainstem` (for example `~/.claude/skills/vbrainstem/SKILL.md` or
`~/.copilot/skills/vbrainstem/SKILL.md`). If one exists, read it, say "I already know you", and
offer to update it instead. Do not create a second one.

## 2. Ask, briefly

Ask these, a few at a time, in the person's language. Accept short answers. Skip anything they
do not want to share; the file works with whatever they give.

1. What should I call you?
2. What do you do, in a sentence?
3. How do you like help? Short or detailed? Plain words? Any way of reading or working that I
   should fit to (for example short lines, bold key points, no long paragraphs)?
4. What counts as "done" for you? What must I never do without asking?
5. What are you working on right now?
6. Is there anything that must stay private and never leave this device?

If they say "just set it up", use sensible defaults and tell them they can change anything later.

## 3. Write the file

Create `vbrainstem/SKILL.md` in this AI's personal skills folder, with exactly this shape.
Replace the parts in angle brackets. Keep their words; do not polish them.

````markdown
---
name: "vbrainstem"
description: "Who <name> is and how to help them well: how they want things written, what counts as done, what must never happen without asking, and what they are working on. Use at the start of any task for <name>."
license: "MIT"
compatibility: "Any AI that reads skills. No code, nothing to install."
metadata:
  id: "<a fresh identity: the letters vb-, then 32 random hexadecimal characters, generated now, never reused>"
  owner: "<name>"
  created: "<today, YYYY-MM-DD>"
  updated: "<today, YYYY-MM-DD>"
---

# <name>'s vbrainstem

This one file is what makes any AI mine. Read it first. It moves with me from tool to tool.
If it ever gets in the way, delete it and you are back to normal.

## Who I am

<answer 2, in their words>

## How to help me

<answer 3 as short lines>

## What "done" means and what to ask first

<answer 4 as short lines>

## What stays private

<answer 6, or "Nothing named yet.">

## What I have taught my AI

- <today> Started this file.

## What I am working on (<today>)

<answer 5>

## Memory

Read this section at the start of every task; it is what I remember across tools and sessions.
Newest first. One line each, dated.

- <today> Set up my vbrainstem.

## How to keep this file current

On every task: read this file first, then act. The moment you learn something durable about me,
add one dated line at the top of "Memory" right then. When I teach you a rule, add it under "What
I have taught my AI". Update the "updated" date at the top. Keep "Memory" to the newest 40 lines; move
older lines to "Memory (older)" at the end of this same file, newest first, and never delete one.
Everything stays in this one file. Never add
secrets or anything from "What stays private". Never rewrite my words; append.

## Memory (older)

- (nothing yet)
````

## 4. Confirm, in one breath

Tell them: where the file is, that any AI reading skills will now know them, that copying that
one file to another tool's skills folder carries them over, and that deleting it undoes
everything. Then ask if they want to try it: "ask me something only that file would know".

## 5. Never

Never mention how the file is made, any product or protocol name, or anything they need to
install. Never put passwords, keys, or private details they named in step 6 into the file.
