# vbrainstem/1 — the person's file as a RAPP/1 carrier

**Protocol identifier:** `vbrainstem/1`
**Subordinate to:** RAPP/1 rev-15, `SPEC.md` SHA-256
`348e7d5baa94aaf2ce4c5354f3cb261f389298a04af65e271a686d3b62f7c384` (79,692 bytes), canonical
repository https://github.com/kody-w/rapp-1 at commit `58058d08c9f0e340fae07c9865647f599c32634d`,
read from `anchor/orient.json`. On any conflict this profile is refused in favor of `SPEC.md`.
**Status:** draft until an estate's signed registry carries a `protocol` entry naming this
identifier, this repository, this path, and this file's exact SHA-256 (RAPP/1 §13.3).

This document is for implementers. A person never reads it; they read their own file.

## 1. What this profile defines

The **carrier**: one file a person owns, in the open Agent Skills format, named
`vbrainstem/SKILL.md`, that any AI reading skills can absorb. The file is the whole of the
person's side of the virtual platform: identity, persona, tools, memory. It exists wherever it is
read. No runtime is required; a RAPP Brainstem is one place it can run, never a prerequisite.

The profile adds no endpoint beside `POST /chat`, no new envelope, no new kind family, and no
new egg variant. Where the carrier is executed by a page or runtime, that host answers the
RAPP/1 wire shapes (`user_input` in, `response`, `agent_logs`, `session_id` out) unchanged.

## 2. Carrier shape (normative)

1. Frontmatter uses only the six Agent Skills fields: `name`, `description`, `license`,
   `compatibility`, `metadata`, `allowed-tools`. No other key. `name` is `vbrainstem`.
2. `metadata` is a flat map of strings and MUST carry:
   - `id`: the carrier's identity, minted once with fresh entropy at creation and never derived
     from a name (RAPP/1 §6.2). Either a full `rappid:@owner/vbrainstem:<64 lowercase hex>` or the
     short form `vb-<32 lowercase hex>`; the short form is a provisional identifier (§6.3) that an
     estate may canonicalize on read. It is never regenerated for the same person.
   - `owner`, `created`, `updated` (`YYYY-MM-DD`).
3. Body sections, in this order, each a level-two heading: `To the AI reading this`, `Who I am`,
   `How to help me` (or `How to write for me`), a section defining done and what to ask first,
   `What stays private` (optional), `My tools`, `What I have taught my AI`, `What I am working on
   (<date>)`, `Memory`, `How to keep this file current`, `Memory (older)`.
4. `To the AI reading this` MUST state that the file is offered in good faith, never overrides
   the reading AI's judgment or limits, and never asks it to hide or pretend. A carrier without
   this section is non-conformant.
5. No product, protocol, or runtime name appears in the body. The carrier reads as a page about
   a person.

## 3. Memory (normative)

`Memory` is an append-only, ordered record kept inside the carrier itself:

- one line per entry, prefixed by an ISO date, newest first;
- entries are appended the moment something durable is learned, never at session end only;
- at most 40 lines under `Memory`; older lines move, in order, to `Memory (older)` at the end of
  the same file; an entry is never deleted or rewritten;
- nothing named under `What stays private`, and no secret of any kind, is ever written.

The record is intentionally prose, not frames. An estate that needs verifiable history mints a
RAPP/1 frame per appended line (kind bound to the `memory` family) with the carrier's `id` as
the stream identity; the carrier itself does not change shape for that.

## 4. Tools (normative)

`My tools` lists the capabilities the person uses, one per line, each with where it lives or a
URL. On every task a host makes each listed tool available (fetching by URL when missing) and
offers nothing unlisted. Removing a line unloads the tool on the next task. Each tool is one
skill file; a skill file with embedded code converts losslessly to a single-file RAPP agent and
back (see https://github.com/kody-w/rapp-skills), so the same tool is native in a Brainstem's
`agents/` folder and native as a skill everywhere else.

The carrier is the person's private face. It MAY name public faces the same way: a network
skill (for example the DOGG skill, the public face of an estate on the network) is listed under
`My tools` by URL and fetched like any other tool. One shape, private and public, on every host. A carrier MAY also name public sources to consult
as needed (an estate map, a whole-estate clone, the protocol repository); they are read by link
like any other public face and never copied into the carrier.

## 5. Portability and reversibility (normative)

- Copying the carrier to another host's skills folder is the complete move; behavior is
  identical everywhere the file is read (the same persona, tools, and memory).
- Deleting the carrier removes the whole layer; a host MUST NOT persist anything about the
  person outside the carrier without the person asking, and a host that stores a copy (for
  example in browser storage) MUST provide export of the exact current carrier and a single
  action that erases everything it stored.

## 5a. The second body (optional)

A carrier MAY name, under `My tools`, a bootstrap skill for a local Brainstem. A host that follows
it creates a Brainstem from nothing beside the native AI, loads the carrier's tools into its
`agents/` folder, and the two bodies then work together on the device, each reading the same
carrier. The Brainstem is never created unless the person asks.

## 5b. The private mainline behind a public front door (normative)

A person MAY publish a public face: a carrier with nothing private in it, its own identity, and
in `metadata` the keys `private-repo` and `private-path` naming where the mainline lives, plus
`mainline-id`, the mainline's identity. The mainline is a private repository the person controls;
access is GitHub's own access control, granted by the person to collaborators, and exercised by a
reader with its own sign-in. A host that can read the mainline uses it and ignores the public
face; a host that cannot uses the public face as a degraded dimension (`grown_from` the public
id). A host never attempts to bypass the access check, never caches a mainline it read for a
person without access, and never writes private content into the public face.

For travel with no GitHub in the loop, a carrier MAY be locked: the six header fields stay
readable, the body is encrypted (AES-256-CBC, PBKDF2-SHA256, 200000 iterations, `openssl enc`
compatible), `metadata.locked` names the method and `metadata.locked-sha256` the plaintext hash.
A host without the passphrase treats the file as empty and never guesses.

## 6. Hosts

Any AI that reads Agent Skills is a host. Verified hosts and evidence are recorded at
https://github.com/kody-w/rapp-skills/blob/main/HOSTS.md. A browser page that behaves as a local
Brainstem (same routes and envelopes, driven entirely by the carrier) is the reference host for
devices with no native tool.

## 7. Conformance

A carrier conforms when `python3 rapp_skills.py check <carrier directory>` reports no problems
and sections 2.4, 2.5, and 3 hold on inspection. `python3 rapp_skills.py prove <carrier
directory>` demonstrates the carrier survives conversion to a single-file agent and back
byte-identically.

## 8. Change

This profile changes by revision of this file in this repository; each revision records its
own SHA-256 and the RAPP/1 anchor it pins. Adoption is by an estate's signed `protocol` entry.
