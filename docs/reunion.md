# Safe manual file travel

Export a complete current file, then import it into the same AI's browser space on
another device. Keep the original export until the imported copy has been checked.
Different AIs belong in different spaces; importing one never replaces another.

## What reunion does

- Ordinary imports require the exact same `metadata.id`. `grown_from` and
  `mainline-id` are ancestry claims, not permission to change identity or rules.
- The selected copy supplies its file details and rules. A differing rule,
  persona, tool list, storage block, or non-date metadata requires explicit
  approval; otherwise the operation refuses and keeps the current file.
- Memories are unioned by their exact entry text, including spaces and indented
  continuations. Existing set-aside sections from both copies are retained.
- Full claimed timestamps determine display order, newest first. Ties compare
  JavaScript strings directly, not the browser's locale. Zone-less times are
  compared as floating clock values using a fixed UTC conversion, not the
  device's timezone. These dates never confer authority.
- Only the recent view is limited to 40 entries. Older entries remain in the file.
- An already incorporated copy is a byte-preserving no-op, even on another day.
- New reunion receipts include a SHA-256 application identifier binding the
  combined memory/evidence set. They are **not RAPP frames, signatures, or proof
  of authorship**. Distinct equal-count reunions no longer share one receipt.

The direct `POST /file/merge` dispatcher returns a proposed file and does not save
it. It cannot accept source approval through its request body. Errors retain the
existing dispatcher error envelope rather than returning success-shaped output.

## Trusted private-source integration

`mergeDimensions()` is now asynchronous. Internal callers must await it.

The signed-source controller can call:

```javascript
await setPersonFile(verifiedPrivateText, "link", {
  approvedSource: {
    id: verifiedIncomingPrivateId,
    previousId: currentlySelectedId
  }
});
```

The controller must verify the source and obtain the user's intended private
selection **before** passing this option. Do not populate it from an imported
file, query parameter, model response, or unverified `mainline-id`.

For the automatic-access contacts, the user's dial request authorizes selecting
available context. The controller verifies both the signed source and existing
GitHub access before approving a same-identity private publication update.

A verified public successor may use the internal `approvedPublication` option
with its exact identity, publisher, and the previous publication's SHA-256. It is
accepted only if the saved file still matches that previous fingerprint and both
identities and publisher bindings agree. A locally edited public file does not
receive this approval. These options are never accepted from the public dispatcher.

The option must name both exact IDs. The incoming file must not declare a public
face or public source. For different IDs, the selected file must also name the
incoming ID as its mainline. These metadata checks narrow an already approved
operation; they do not authenticate it.

Approval adopts the incoming private identity/rules, unions the memories and
existing evidence, and retains the previous file details/rules in a fenced,
explicitly non-current evidence section. Unrelated AI replacement stays refused.
The parent dial controller must handle this explicitly approved upgrade before
its ordinary `sameAI()` guard, which now compares exact IDs only.

`setPersonFileFresh()` is not a replacement bypass: when a file exists, it routes
through ordinary reunion without approval.

## Save and failure behavior

Imports validate before saving and check that the selected file has not changed
during asynchronous work. A thrown tool-cache error rolls back the staged file,
unless another writer has already replaced it; that newer file is left alone.
An initial import with a thrown cache error leaves no file. A recoverable tool
fetch warning may leave a complete validated file with a visible warning.

The editor keeps the base it displayed. If storage changes behind it, saving is
refused visibly and the draft remains available. Export that draft if needed,
then reload before editing again. Temporarily invalid editor text does not
replace the last complete saved file.

## Limits

This is conservative manual snapshot travel, not a distributed history protocol.
It cannot prove ancestry/authorship, recover a lost unexported device, distinguish
independent observations with identical legacy text, or guarantee arbitrary
multi-writer merge convergence. It does not provide a cross-device lock. Ambiguous
policy changes are refused rather than elected by dates. Older receipts already
collapsed by previous software cannot be reconstructed.

Legacy carrier validation remains in place; this change does not establish
cryptographic export completeness or migrate carriers to the HTML profile.
Export downloads the exact current editor text, so a refused editor draft is a
draft export, not a successfully committed snapshot.

## Regression command

Use the repository's existing Playwright installation:

```bash
cd tests
VB_TEST_PORT=4291 PYTHONDONTWRITEBYTECODE=1 npm test -- reunion.spec.js dialing.spec.js --workers=1
```
