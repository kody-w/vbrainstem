# Four synthetic AI publication fixtures

`tools/dial_pairs.py` creates local, immutable public/private publication packages
for `vb-atlas` (research), `vb-forge` (builder), `vb-quill` (writer), and
`vb-harbor` (planner). The catalog is `tools/dial_pairs_catalog.json`.
Public/private faces may be called DOGG/GODD; these labels introduce no RAPP wire
field, kind family, endpoint, or egg variant.

No command publishes, contacts GitHub, starts a model, imports personal memory, or
loads a private API. Every private sample is synthetic. Public/private association
is deliberately disclosed for this demo.

## Test first

Use Python 3.11+ on a POSIX host. If `cryptography` is missing, install the tested
dependency into your Python environment:

```sh
python3 -m pip install -r tests/requirements-dial-pairs.txt
```

Run the focused gate from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -p test_dial_pairs.py -v
```

Tests create and remove their fixtures under the already ignored
`tests/test-results/`, not the operating system's temporary directory. They check:

- Four distinct personas, eight independent carrier IDs, and four signing owners.
- Signed registries, registered nonempty genesis chains, detached frame and receipt
  signatures, exact skill bytes, and public-only redirects.
- Wrong owner, unsigned/tampered documents, duplicate JSON members, unrelated
  streams, bad chain links, missing kind/protocol/genesis bindings, and extra files.
- No private marker, private content hash, private frame hash, or signing key in
  public artifacts.
- Mint-once replay, missing keys/packages, symlinks, path traversal, separate key
  storage, and private key permissions.

## Create, then verify

Choose disjoint absolute directories outside public folders and Git checkouts for
real publication staging and signing keys. Do not commit the signing directory.

```sh
python3 tools/dial_pairs.py create \
  --slug vb-atlas --owner kody-w \
  --output /path/to/local-packages \
  --key-dir /path/to/local-signing-keys

python3 tools/dial_pairs.py verify \
  --directory /path/to/local-packages/vb-atlas \
  --expected-owner 'rappid:@kody-w/vb-atlas-estate:THE_SAVED_64_HEX_TAIL'
```

Use the actual `estate_owner` printed by the first creation, retained through a
trusted channel. Never obtain the verification argument from an untrusted
download's own declaration. Repeat `create` for the other three catalog slugs.
`create` returns `directory`, the seven binding fields below, and `dial_url`;
`verify` returns `status: "verified"`, `faces_checked`, and `frames_checked`.
Failures raise `ValueError` through the API and exit nonzero through the CLI.

An existing pair is verified without rewriting any bytes or keys. A missing
package with a retained key, missing key with a retained package, incomplete
package, unrelated directory, or insecure/unrecognized key is refused rather than
silently reminted. Preserve the existing material and recover from a known backup;
this tool does not rotate keys or repair publications. Key publication uses an
exclusive 0600 staging file and an atomic non-overwriting link in the separate key
directory. The complete key is never staged in a package.

## Package layout

```text
<output>/<slug>/
  public/
    <slug>/SKILL.md
    DIAL.json
    FRAME.json
    FRAMES.jsonl
    registry.json
    rappid.json
    index.html
  private/
    vbrainstem/SKILL.md
    DIAL.json
    FRAME.json
    FRAMES.jsonl
    registry.json
    rappid.json
```

The private receipt is an identical copy of the public receipt; it contains no
private content or private-content fingerprint. Each face's registry registers
only its own stream genesis. Additional publication files are refused. A real
`.git` directory at either face root is ignored as local repository metadata;
symlinked metadata is still refused. The verifier is not a Git-history scanner.

`SKILL.md` is an existing Markdown carrier, not a claimed canonical-HTML artifact.
Its five top-level fields are `name`, `description`, `license`, `compatibility`,
and `metadata`. Metadata is a flat map of strings, including identity, face,
signing owner, locators, profile, and `private-load: "explicit"`. Its signed
publication covers these fields and every body byte. The carrier links the virtual
core and inherits ContextMemory, HackerNews, ManageMemory, and LearnNew rather than
installing duplicate tools. Each persona has a distinct acceptance prompt.

## Exact signature and binding contract

All emitted JSON files are exact UTF-8 `R.canonical(document)` bytes plus one LF.
Each `FRAMES.jsonl` line has the same canonical encoding. Verification accepts the
canonical bytes with zero or one terminal LF, not arbitrary whitespace, CRLF, or
blank frame lines. Browser readers can parse and compare against canonical bytes
before signature validation; duplicate keys cannot survive that byte-equality
check. Do not use general `trim()` or silently normalize received bytes.

All JSON uses the pinned reference canonicalizer. Every signature is detached
compact JWS over `canonical(document without sig)`, with protected header exactly:

```json
{"alg":"EdDSA","b64":false,"crit":["b64"],"kid":"<estate_owner>"}
```

The signing input is the base64url-encoded protected header, a period, then the
**unencoded** canonical document bytes. Ed25519 signing uses `cryptography`;
verification uses the unchanged RAPP reference verifier. The estate-owner RAPPID
is bound to the SHA-256 domain-separated SPKI DER commitment through
`R.mint_rappid(..., spki_der=...)`. Carrier identities are independently minted by
the reference implementation. Each `rappid.json` is exactly
`{"schema":"rapp/1","rappid":"<carrier_id>","grown_from":null}`. No egg ancestry is
claimed; an identity is never inserted into `grown_from`.

### `DIAL.json`: `vbrainstem-dial/1`

The exact members are:

| Member | Value |
|---|---|
| `schema` | `vbrainstem-dial/1` |
| `utc` | Fixed RAPP UTC timestamp |
| `estate_owner` | Independently trusted keyed RAPPID |
| `public_id` | Public carrier RAPPID |
| `private_id` | Independent private carrier RAPPID |
| `public_repo` | `<owner>/<slug>` |
| `public_skill_path` | `<slug>/SKILL.md` |
| `private_repo` | `<owner>/<slug>-private` |
| `private_skill_path` | `vbrainstem/SKILL.md` |
| `registry_url` | `https://raw.githubusercontent.com/<owner>/<slug>/main/registry.json` |
| `entries_key` | Exactly `entries`, the explicit §13 interoperability agreement |
| `public_head` | The **complete 11-member signed public frame**, not just its hash |
| `public_sha256` | SHA-256 of exact public `SKILL.md` bytes |
| `sig` | Owner's detached JWS |

The seven fields from `estate_owner` through `private_skill_path` are the shared
binding fields. Neither DIAL copy contains the private skill hash or private head.

### Frames and registries

Frames retain exactly the 11 RAPP/1 envelope members supplied by `R.build_frame`.
`kind: "body.publish"` is explicitly registered to family `body` in each estate
registry. Each initial chain contains one signed genesis, `seq: 0`, `prev: null`,
and `prev_wave: null`. `FRAME.json` must equal the actual chain head.

The exact publication payload members are the seven shared binding fields plus:

```json
{
  "schema": "vbrainstem-carrier/1",
  "face": "public or private",
  "rappid": "<this face's ID>",
  "path": "<this face's skill path>",
  "bytes": 123,
  "sha256": "<SHA-256 of this face's exact SKILL.md bytes>"
}
```

Each `rapp/1-registry` has `schema`, `registry_seq`, `created_utc`, `entries`, and
`sig`. Initial `registry_seq` is zero. Entries include the pinned `rapp/1` protocol,
`estate_owner`, SPKI, live `body.publish` kind binding, and this face's genesis.
Verification uses `rapp_registry.load_document(entries_member="entries",
allow_unsigned=False)`, `Registry.signature_verifier`, registered genesis/kind
checks, and `R.verify_frame` with the recorded stream ID and predecessor.

The unchanged reference sources and license are in `tools/rapp1/`. Pins:

- Commit: `58058d08c9f0e340fae07c9865647f599c32634d`
- Rev15 `SPEC.md`: `348e7d5baa94aaf2ce4c5354f3cb261f389298a04af65e271a686d3b62f7c384`
- `rapp.py`: `1a04362b02f14c1e37b70c6b4f72d79e92df1cc9c2b5b394e8e1b141fc0b6050`
- `rapp_registry.py`: `0e268e3e4c9e175a35b1fa6790812af553fa5e5703e1cab3fb64d73eaaa4e9be`

The loader checks source hashes before execution. `PIN.json` includes the license
hash and provenance; no runtime fetch or alternate verifier is used.

## Publishing and browser handoff

Publishing is a separate, explicitly authorized operation:

1. Run the local gate. Create `<owner>/<slug>` **public** and
   `<owner>/<slug>-private` **private**; confirm visibility before pushing either
   directory. Never enable Pages for the private repository.
2. Push only each corresponding face directory. Keep private files, keys, local
   caches, and test reports out of the public repository and its Git history.
3. Enable Pages on the public root. Its generated page redirects to:
   `https://kody-w.github.io/vbrainstem/?dial=<owner>/<slug>&space=<owner>/<slug>&face=public&trust=<percent-encoded-estate-owner>`.
   `space` selects only a per-AI browser storage namespace. It is not a RAPP
   identity or authorization grant and is not added to the signed receipt.
   Links without an explicit `space` retain the host's legacy storage behavior.
4. Test anonymous public loading, deliberately authorized private loading, and
   copying/exporting between isolated browser contexts. Use each sample prompt
   against the real host; report what actually ran.

The host must validate the receipt/registry against the trusted owner, verify the
public frame and byte hash, and request private access only after a separate
explicit action. Show the resolved private source and verified head when loading
the latest private snapshot. Do not silently fall back to public as if private
loading succeeded.

The public browser verifier must use native WebCrypto Ed25519. If it is unavailable or
unsupported, show verification as unavailable and refuse trusted loading. There is
no unsigned, simulated, or alternate-algorithm fallback.

These gates prove the emitted snapshots' signatures, bindings, and isolation—not
global freshness, correct behavior of a model, safe execution of arbitrary tools,
or conformance of unrelated existing repository files. The linked virtual core is
a source link, not a pinned executable guarantee. There is no new account system,
automatic reunion, encryption-at-rest promise for carrier files, key recovery, or
cross-device rollback service. Local edits no longer match the published hash.
An untrusted link carrying its own `trust` value is not an independent trust anchor.
