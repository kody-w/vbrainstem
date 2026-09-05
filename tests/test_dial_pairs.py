"""Release gates for household favorites and compatible legacy publication pairs."""
import base64
import copy
from datetime import datetime, timezone
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import unittest
from unittest import mock
from urllib.parse import parse_qs, quote, urlsplit
import uuid

from cryptography.hazmat.primitives import serialization


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dial_pairs", ROOT / "tools" / "dial_pairs.py")
DIAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAL)

LEGACY_ACCESS_POLICY = """Loading the latest private mainline is a separate explicit request, never automatic.
Show its actual source and verification result when loaded; a saved snapshot does
not prove it is the latest. Never silently substitute a public file for a requested
private load, or treat a copied identifier as authorization."""
AUTOMATIC_ACCESS_POLICY = """On dial, the host automatically tries the full AI with existing GitHub
credentials and uses the shared AI only when access is absent or denied.
Do not offer a public/private choice, start new authorization, or silently widen
permissions. Never fabricate private memory or treat identifiers as authorization.
Corrupted, invalid, or unverifiable publications are errors, not access denial;
report them instead of silently falling back.
Do not volunteer public/private or repository internals in normal introductions.
Provide truthful source, access, and verification diagnostics when asked; a saved
snapshot does not prove it is the latest."""
LEGACY_CATALOG_SHA256 = {
    "vb-atlas": "22437e8d61abce6f9a005819674b2b9b5e44246977a6d8dfee37c0eef6d4bc15",
    "vb-forge": "972b46ed894abf6b8c926a00f10442cc9f0f7da808cd0b956940e5b798988011",
    "vb-quill": "4aea94aab54edaa625c1221d53874bbc4c1c2214633e5066762176a42507627b",
    "vb-harbor": "7a2d0a0a584196722c30a4109fadcb192d64cb78e55d738643ea13cb13af7829",
}


class DialPairs(unittest.TestCase):
    def setUp(self):
        self.base = ROOT / "tests" / "test-results" / ("dial-pairs-" + uuid.uuid4().hex)
        self.base.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.base)
        self.output = self.base / "packages"
        self.keys = self.base / "keys"

    def create_pair(self, slug="vb-atlas"):
        return DIAL.create_pair(slug, owner="kody-w", output=self.output, key_dir=self.keys)

    def resign(self, document):
        """Exercise profile checks with valid cryptography, not just broken signatures."""
        key_path = next(self.keys.glob("*.pem"))
        key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        protected = document["sig"].split(".")[0]
        unsigned = {key: value for key, value in document.items() if key != "sig"}
        signature = key.sign(protected.encode("ascii") + b"." + DIAL.R.canonical(unsigned).encode("utf-8"))
        document["sig"] = protected + ".." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
        return document

    def encode_json(self, document):
        return (DIAL.R.canonical(document) + "\n").encode("utf-8")

    def snapshot(self):
        return {path.relative_to(self.base): path.read_bytes()
                for path in self.base.rglob("*") if path.is_file()}

    def legacy_pair(self, slug="vb-atlas"):
        """Make an independent, signed seq=0 explicit-policy fixture with synthetic keys."""
        pair = self.create_pair(slug)
        directory = Path(pair["directory"])
        binding = {name: pair[name] for name in DIAL.BINDING_KEYS}
        entry = DIAL.load_catalog()[slug]
        key = DIAL._load_key(self.keys / ("kody-w-" + slug + ".ed25519.pem"))
        utc = "2020-01-02T03:04:05.000Z"
        heads = {}
        for face in ("public", "private"):
            skill = DIAL._skill(binding, face, entry, utc[:10]).decode("utf-8")
            skill = skill.replace('  private-load: "auto-if-authorized"\n',
                                  '  private-load: "explicit"\n', 1)
            skill = skill.replace(AUTOMATIC_ACCESS_POLICY, LEGACY_ACCESS_POLICY, 1)
            intro = f"I am {entry['name']}, a synthetic {entry['role']} assistant."
            skill = skill.replace(f"## Who I am\n\n{intro}\n",
                                  f"## Who I am\n\n{intro} This is my {face} face.\n", 1)
            self.assertIn('  private-load: "explicit"\n', skill)
            self.assertIn(LEGACY_ACCESS_POLICY, skill)
            data = skill.encode("utf-8")
            frame = DIAL.R.build_frame(
                kind=DIAL.KIND, stream_id=binding[face + "_id"], seq=0, utc=utc,
                payload=DIAL._publication(binding, face, data), prev=None,
            )
            frame = DIAL._sign(frame, key, pair["estate_owner"])
            heads[face] = frame
            (directory / face / binding[face + "_skill_path"]).write_bytes(data)
            for name in ("FRAME.json", "FRAMES.jsonl"):
                (directory / face / name).write_bytes(self.encode_json(frame))
            (directory / face / "registry.json").write_bytes(
                self.encode_json(DIAL._registry(binding, frame, key)))
        receipt = json.loads((directory / "public" / "DIAL.json").read_bytes())
        receipt.update(utc=utc, public_head=heads["public"],
                       public_sha256=heads["public"]["payload"]["sha256"])
        receipt = self.encode_json(DIAL._sign(receipt, key, pair["estate_owner"]))
        for face in ("public", "private"):
            (directory / face / "DIAL.json").write_bytes(receipt)
        url = html.escape(
            "https://kody-w.github.io/vbrainstem/?dial=" + binding["public_repo"]
            + "&space=" + binding["public_repo"] + "&face=public&trust="
            + quote(binding["estate_owner"], safe=""), quote=True)
        (directory / "public" / "index.html").write_bytes((
            '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            f'<meta http-equiv="refresh" content="0; url={url}"><title>Open synthetic AI</title>'
            f'</head><body><p><a href="{url}">Open the public synthetic AI</a></p>'
            '<p>Private loading requires a separate explicit request.</p></body></html>\n'
        ).encode("utf-8"))
        return pair

    def publish_skill(self, pair, face, data):
        """Publish synthetic prior learning without rewriting the registered genesis."""
        directory = Path(pair["directory"])
        binding = {name: pair[name] for name in DIAL.BINDING_KEYS}
        owner, slug = pair["public_repo"].split("/")
        key = DIAL._load_key(self.keys / (owner + "-" + slug + ".ed25519.pem"))
        head = json.loads((directory / face / "FRAME.json").read_bytes())
        frame = DIAL.R.build_frame(
            kind=DIAL.KIND, stream_id=binding[face + "_id"], seq=head["seq"] + 1,
            utc="2020-01-03T03:04:05.000Z", payload=DIAL._publication(binding, face, data),
            prev=head["payload_hash"],
        )
        frame = DIAL._sign(frame, key, pair["estate_owner"])
        (directory / face / binding[face + "_skill_path"]).write_bytes(data)
        (directory / face / "FRAME.json").write_bytes(self.encode_json(frame))
        chain = directory / face / "FRAMES.jsonl"
        chain.write_bytes(chain.read_bytes().rstrip(b"\n") + b"\n" + self.encode_json(frame))
        if face == "public":
            receipt = json.loads((directory / "public" / "DIAL.json").read_bytes())
            receipt.update(utc=frame["utc"], public_head=frame,
                           public_sha256=frame["payload"]["sha256"])
            data = self.encode_json(DIAL._sign(receipt, key, pair["estate_owner"]))
            for name in ("public", "private"):
                (directory / name / "DIAL.json").write_bytes(data)

    def test_catalog_has_seven_supported_roles_and_exactly_four_household_favorites(self):
        catalog = DIAL.load_catalog()
        self.assertEqual(set(catalog), {
            "vb-overwatch", "vb-scout", "vb-forge", "vb-sentinel",
            "vb-atlas", "vb-quill", "vb-harbor",
        })
        self.assertEqual(DIAL.DEFAULT_FAVORITES, ("vb-overwatch", "vb-scout", "vb-forge", "vb-sentinel"))
        self.assertEqual(len({entry["role"] for entry in catalog.values()}), 7)
        self.assertEqual({slug for slug, entry in catalog.items() if entry["default_favorite"]},
                         set(DIAL.DEFAULT_FAVORITES))
        for entry in catalog.values():
            self.assertTrue(entry["name"])
            self.assertTrue(entry["description"])
            self.assertTrue(entry["sample_prompt"])
            self.assertIsInstance(entry["default_favorite"], bool)

    def test_legacy_catalog_content_is_unchanged_for_existing_publications(self):
        catalog = DIAL.load_catalog()
        for slug, expected in LEGACY_CATALOG_SHA256.items():
            content = {name: catalog[slug][name] for name in
                       ("name", "role", "description", "working_style", "sample_prompt")}
            self.assertEqual(hashlib.sha256(DIAL.R.canonical(content).encode("utf-8")).hexdigest(),
                             expected, slug)

    def test_catalog_refuses_missing_or_conflicting_favorite_flags(self):
        original = DIAL.load_catalog()
        for slug, value in (("vb-atlas", True), ("vb-forge", False), ("vb-scout", 1)):
            catalog = copy.deepcopy(original)
            catalog.setdefault(slug, {})["default_favorite"] = value
            with self.subTest(slug=slug, value=value), \
                    mock.patch.object(DIAL, "_read", return_value=self.encode_json(catalog)), \
                    self.assertRaises(ValueError):
                DIAL.load_catalog()
        catalog = copy.deepcopy(original)
        catalog["vb-forge"].pop("default_favorite", None)
        with mock.patch.object(DIAL, "_read", return_value=self.encode_json(catalog)), \
                self.assertRaises(ValueError):
            DIAL.load_catalog()

    def test_new_role_contacts_start_fresh_and_do_not_modify_existing_forge_or_legacy_pairs(self):
        existing = {}
        markers = [("LEGACY_LEARNING_ONLY_" + slug).encode() for slug in LEGACY_CATALOG_SHA256]
        for slug, marker in zip(LEGACY_CATALOG_SHA256, markers):
            pair = existing[slug] = self.legacy_pair(slug)
            for face in ("public", "private"):
                path = Path(pair["directory"]) / face / pair[face + "_skill_path"]
                self.publish_skill(pair, face, path.read_bytes() + b"\n- " + marker + b"\n")
        before = self.snapshot()
        for slug in ("vb-overwatch", "vb-scout", "vb-sentinel"):
            pair = self.create_pair(slug)
            self.assertEqual(pair["public_repo"], "kody-w/" + slug)
            self.assertEqual(pair["private_repo"], "kody-w/" + slug + "-private")
            for face in ("public", "private"):
                root = Path(pair["directory"]) / face
                self.assertEqual(json.loads((root / "FRAME.json").read_bytes())["seq"], 0)
                skill = (root / pair[face + "_skill_path"]).read_bytes()
                for marker in markers:
                    self.assertNotIn(marker, skill)
                self.assertIn(b'  private-load: "auto-if-authorized"\n', skill)
            self.assertNotIn("face", parse_qs(urlsplit(pair["dial_url"]).query))
        after = self.snapshot()
        for path, data in before.items():
            self.assertEqual(after[path], data, str(path))
        for pair in existing.values():
            verdict = DIAL.verify_pair(pair["directory"], pair["estate_owner"])
            self.assertEqual(verdict["frames_checked"], 4)
            for name in ("public_id", "private_id", "estate_owner"):
                self.assertEqual(verdict[name], pair[name])

    def test_positive_pairs_have_verified_registry_and_nonempty_frame_chains(self):
        for slug in DIAL.load_catalog():
            with self.subTest(slug=slug):
                pair = self.create_pair(slug)
                verdict = DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])
                self.assertEqual(verdict["status"], "verified")
                self.assertEqual(verdict["faces_checked"], 2)
                self.assertGreaterEqual(verdict["frames_checked"], 2)
                self.assertNotEqual(pair["public_id"], pair["private_id"])
                self.assertTrue(DIAL.R.rappid_valid(pair["public_id"]))
                self.assertTrue(DIAL.R.rappid_valid(pair["private_id"]))
                query = parse_qs(urlsplit(pair["dial_url"]).query)
                self.assertEqual(query.get("space"), ["kody-w/" + slug])
                self.assertEqual(verdict["dial_url"], pair["dial_url"])
                index = (Path(pair["directory"]) / "public" / "index.html").read_text()
                self.assertIn("space=kody-w/" + slug, index)

    def test_each_persona_has_an_independent_identity(self):
        identities = set()
        for slug in DIAL.load_catalog():
            pair = self.create_pair(slug)
            identities.update((pair["public_id"], pair["private_id"], pair["estate_owner"]))
        self.assertEqual(len(identities), 21)

    def test_all_generated_json_and_frame_lines_are_canonical_bytes(self):
        for slug in DIAL.load_catalog():
            pair = self.create_pair(slug)
            for path in Path(pair["directory"]).rglob("*"):
                if path.suffix == ".json":
                    data = path.read_bytes()
                    self.assertEqual(data, self.encode_json(json.loads(data)), str(path))
                elif path.name == "FRAMES.jsonl":
                    data = path.read_bytes()
                    expected = b"".join(self.encode_json(json.loads(line)) for line in data.splitlines())
                    self.assertEqual(data, expected, str(path))

    def test_noncanonical_artifacts_are_refused_despite_valid_signatures(self):
        pair = self.create_pair()
        for name in ("DIAL.json", "registry.json", "FRAME.json", "FRAMES.jsonl"):
            path = Path(pair["directory"]) / "public" / name
            original = path.read_bytes()
            for changed in (b" " + original, original + b"\n", original.replace(b"\n", b"\r\n")):
                path.write_bytes(changed)
                try:
                    with self.subTest(name=name, prefix=changed[:1]), self.assertRaises(ValueError):
                        DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])
                finally:
                    path.write_bytes(original)

    def test_json_may_omit_its_single_trailing_lf(self):
        pair = self.create_pair()
        for path in Path(pair["directory"]).rglob("*"):
            if path.suffix == ".json" or path.name == "FRAMES.jsonl":
                data = path.read_bytes()
                self.assertTrue(data.endswith(b"\n"))
                path.write_bytes(data[:-1])
        self.assertEqual(DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])["status"], "verified")

    def test_repeated_create_preserves_identity_bytes_and_keys(self):
        first = self.create_pair()
        before = {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*") if p.is_file()}
        second = self.create_pair()
        after = {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*") if p.is_file()}
        self.assertEqual(first, second)
        self.assertEqual(before, after)

    def test_public_package_cannot_contain_private_carrier_or_signing_key(self):
        pair = self.create_pair()
        public = Path(pair["directory"]) / "public"
        private = Path(pair["directory"]) / "private"
        private_text = (private / "vbrainstem" / "SKILL.md").read_text(encoding="utf-8")
        private_hash = hashlib.sha256(private_text.encode("utf-8")).hexdigest()
        private_head = json.loads((private / "FRAME.json").read_text(encoding="utf-8"))
        self.assertIn(DIAL.PRIVATE_TEST_MARKER, private_text)
        for path in public.rglob("*"):
            if path.is_file():
                text = path.read_text(encoding="utf-8")
                self.assertNotIn(DIAL.PRIVATE_TEST_MARKER, text, str(path))
                self.assertNotIn("PRIVATE KEY", text, str(path))
                self.assertNotEqual(text, private_text, str(path))
                self.assertNotIn(private_hash, text, str(path))
                self.assertNotIn(private_head["frame_hash"], text, str(path))
        for path in Path(pair["directory"]).rglob("*"):
            if path.is_file():
                self.assertNotIn("PRIVATE KEY", path.read_text(encoding="utf-8"), str(path))

    def test_wrong_trust_anchor_is_refused(self):
        pair = self.create_pair()
        wrong = self.create_pair("vb-forge")
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=wrong["estate_owner"])

    def test_changed_skill_is_refused(self):
        pair = self.create_pair()
        path = Path(pair["directory"]) / "public" / "vb-atlas" / "SKILL.md"
        path.write_text(path.read_text(encoding="utf-8") + "\nUnapproved change.\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_invalid_signature_and_unsigned_registry_are_refused(self):
        pair = self.create_pair()
        path = Path(pair["directory"]) / "public" / "registry.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        for signature in (None, "invalid-signature"):
            with self.subTest(signature=signature):
                document = copy.deepcopy(original)
                document["sig"] = signature
                path.write_bytes(self.encode_json(document))
                with self.assertRaises(ValueError):
                    DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])
        path.write_bytes(self.encode_json(original))

    def test_foreign_stream_and_corrupt_hash_are_refused(self):
        pair = self.create_pair()
        path = Path(pair["directory"]) / "public" / "FRAMES.jsonl"
        original = path.read_text(encoding="utf-8")
        frames = [json.loads(line) for line in original.splitlines() if line.strip()]
        self.assertGreater(len(frames), 0)
        for key, value in (("stream_id", pair["private_id"]), ("payload_hash", "0" * 64)):
            with self.subTest(key=key):
                changed = copy.deepcopy(frames)
                changed[0][key] = value
                path.write_bytes(b"".join(self.encode_json(frame) for frame in changed))
                with self.assertRaises(ValueError):
                    DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])
        path.write_text(original, encoding="utf-8")

    def test_empty_chain_is_a_failure_not_a_zero_artifact_pass(self):
        pair = self.create_pair()
        path = Path(pair["directory"]) / "public" / "FRAMES.jsonl"
        path.write_text("", encoding="utf-8")
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_no_overwrite_of_unrecognized_existing_package(self):
        target = self.output / "vb-atlas"
        target.mkdir(parents=True)
        sentinel = target / "keep.txt"
        sentinel.write_text("pre-existing user work", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.create_pair()
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "pre-existing user work")

    def test_unsafe_owner_or_slug_never_writes(self):
        for slug, owner in (("../escape", "kody-w"), ("vb-atlas", "../escape")):
            with self.subTest(slug=slug, owner=owner), self.assertRaises(ValueError):
                DIAL.create_pair(slug, owner=owner, output=self.output, key_dir=self.keys)
        self.assertFalse(self.output.exists())

    def test_signed_dial_receipt_and_automatic_access_redirect(self):
        pair = self.create_pair()
        public = Path(pair["directory"]) / "public"
        receipt = json.loads((public / "DIAL.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["schema"], "vbrainstem-dial/1")
        self.assertEqual(receipt["estate_owner"], pair["estate_owner"])
        self.assertEqual(receipt["entries_key"], "entries")
        self.assertEqual(receipt["public_repo"], "kody-w/vb-atlas")
        self.assertEqual(receipt["private_repo"], "kody-w/vb-atlas-private")
        self.assertEqual(receipt["public_skill_path"], "vb-atlas/SKILL.md")
        self.assertEqual(receipt["private_skill_path"], "vbrainstem/SKILL.md")
        self.assertEqual(receipt["public_head"], json.loads((public / "FRAME.json").read_text()))
        self.assertEqual(receipt["public_sha256"], hashlib.sha256((public / "vb-atlas" / "SKILL.md").read_bytes()).hexdigest())
        self.assertEqual(DIAL.R.parse_detached_jws(receipt["sig"])[0]["kid"], pair["estate_owner"])
        self.assertNotIn("space", receipt)
        self.assertEqual(parse_qs(urlsplit(pair["dial_url"]).query), {
            "dial": ["kody-w/vb-atlas"], "space": ["kody-w/vb-atlas"],
            "trust": [pair["estate_owner"]],
        })
        index = (public / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("face=public", index)
        self.assertNotIn("face=private", index)
        self.assertIn("available access", index)
        self.assertNotIn("separate explicit request", index)

    def test_new_packages_use_automatic_existing_access_without_choice_or_false_fallback(self):
        for slug in DIAL.DEFAULT_FAVORITES:
            pair = self.create_pair(slug)
            for face in ("public", "private"):
                with self.subTest(slug=slug, face=face):
                    skill = (Path(pair["directory"]) / face / pair[face + "_skill_path"]).read_text()
                    self.assertIn('  private-load: "auto-if-authorized"\n', skill)
                    self.assertIn(AUTOMATIC_ACCESS_POLICY, skill)
                    self.assertNotIn(LEGACY_ACCESS_POLICY, skill)
                    self.assertNotIn(f"This is my {face} face.", skill)

    def test_legacy_explicit_pair_still_verifies_before_revision(self):
        pair = self.legacy_pair()
        before = self.snapshot()
        verdict = DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])
        self.assertEqual(verdict["status"], "verified")
        self.assertEqual(verdict["frames_checked"], 2)
        self.assertEqual(self.snapshot(), before)

    def test_legacy_catalog_entries_revise_with_their_existing_keys_and_identities(self):
        for slug in LEGACY_CATALOG_SHA256:
            with self.subTest(slug=slug):
                pair = self.legacy_pair(slug)
                result = DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
                self.assertEqual(result["status"], "revised")
                for name in DIAL.BINDING_KEYS:
                    self.assertEqual(result[name], pair[name])
                self.assertEqual(DIAL.verify_pair(pair["directory"], pair["estate_owner"])["frames_checked"], 4)

    def test_revise_preserves_ids_keys_registries_genesis_and_canonical_history(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        before = self.snapshot()
        started = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        result = DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        ended = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.assertEqual(result["status"], "revised")
        self.assertEqual(result["faces_revised"], ["public", "private"])
        backup = Path(result["previous_directory"])
        self.assertEqual(backup.parent, directory.parent)
        self.assertNotEqual(backup, directory)
        self.assertEqual(
            {path.relative_to(backup): path.read_bytes() for path in backup.rglob("*") if path.is_file()},
            {path.relative_to(directory.relative_to(self.base)): data
             for path, data in before.items() if path.is_relative_to(directory.relative_to(self.base))},
        )
        self.assertEqual(DIAL.verify_pair(backup, pair["estate_owner"])["frames_checked"], 2)
        for name in DIAL.BINDING_KEYS:
            self.assertEqual(result[name], pair[name])
        changed = {"public/index.html"}
        for face in ("public", "private"):
            changed.update(face + "/" + name for name in
                           (pair[face + "_skill_path"], "FRAME.json", "FRAMES.jsonl", "DIAL.json"))
            root = directory / face
            old_chain = before[(root / "FRAMES.jsonl").relative_to(self.base)]
            old_head = json.loads(old_chain.splitlines()[-1])
            chain = (root / "FRAMES.jsonl").read_bytes()
            self.assertTrue(chain.startswith(old_chain))
            self.assertEqual(len(chain.splitlines()), 2)
            head = json.loads((root / "FRAME.json").read_bytes())
            self.assertEqual(head["seq"], old_head["seq"] + 1)
            self.assertEqual(head["prev"], old_head["payload_hash"])
            self.assertIsNone(head["prev_wave"])
            self.assertTrue(DIAL.R.utc_valid(head["utc"]))
            self.assertLessEqual(started, head["utc"])
            self.assertLessEqual(head["utc"], ended)
            self.assertEqual(chain[len(old_chain):], self.encode_json(head))
            self.assertEqual((root / "FRAME.json").read_bytes(), self.encode_json(head))
            skill = (root / pair[face + "_skill_path"]).read_bytes()
            self.assertIn(b'  created: "2020-01-02"\n', skill)
            self.assertIn(('  updated: "' + head["utc"][:10] + '"\n').encode(), skill)
            self.assertIn(b'  private-load: "auto-if-authorized"\n', skill)
            self.assertEqual(head["payload"]["sha256"], hashlib.sha256(skill).hexdigest())
        for relative, original in before.items():
            if not relative.is_relative_to(directory.relative_to(self.base)) or (
                    relative.relative_to(directory.relative_to(self.base)).as_posix() not in changed):
                self.assertEqual(self.snapshot()[relative], original, str(relative))
        receipt_bytes = (directory / "public" / "DIAL.json").read_bytes()
        receipt = json.loads(receipt_bytes)
        self.assertEqual(receipt_bytes, self.encode_json(receipt))
        self.assertEqual(receipt_bytes, (directory / "private" / "DIAL.json").read_bytes())
        self.assertEqual(receipt["public_head"], json.loads((directory / "public" / "FRAME.json").read_bytes()))
        self.assertEqual(DIAL.verify_pair(directory, pair["estate_owner"])["frames_checked"], 4)
        self.assertNotIn("face", parse_qs(urlsplit(result["dial_url"]).query))
        self.assertIn(b"available access", (directory / "public" / "index.html").read_bytes())

    def test_revise_preserves_published_learning_and_storage_without_regenerating_carriers(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        for face in ("public", "private"):
            path = directory / face / pair[face + "_skill_path"]
            skill = path.read_bytes()
            notes = ("\n- 2020-01-03 User-added learning: retain café and 🧭 byte for byte.\n"
                     "\n## Storage\n\n```text\n## What done means and what to ask first\n\n"
                     + LEGACY_ACCESS_POLICY
                     + '\n  private-load: "explicit"\n  updated: "2020-01-02"\n'
                     + f"## Who I am\n\nThis is my {face} face.\n```\n").encode("utf-8")
            self.publish_skill(pair, face, skill + notes)
        before = self.snapshot()
        with mock.patch.object(DIAL, "_skill", side_effect=AssertionError("must not regenerate a carrier")):
            DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        for face in ("public", "private"):
            path = directory / face / pair[face + "_skill_path"]
            original = before[path.relative_to(self.base)]
            current = path.read_bytes()
            boundary = b"\n## What I have taught my AI\n"
            self.assertEqual(current.split(boundary, 1)[1], original.split(boundary, 1)[1])
            old_chain = before[(directory / face / "FRAMES.jsonl").relative_to(self.base)]
            self.assertTrue((directory / face / "FRAMES.jsonl").read_bytes().startswith(old_chain))
        self.assertEqual(DIAL.verify_pair(directory, pair["estate_owner"])["frames_checked"], 6)

    def test_revise_is_a_byte_identical_noop_after_the_first_revision(self):
        pair = self.legacy_pair()
        DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        before = self.snapshot()
        with mock.patch.object(DIAL.R, "build_frame", side_effect=AssertionError("unexpected extra frame")), \
                mock.patch.object(DIAL, "_sign", side_effect=AssertionError("unexpected signature")):
            result = DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(result["faces_revised"], [])
        self.assertEqual(self.snapshot(), before)
        for face in ("public", "private"):
            skill = (Path(pair["directory"]) / face / pair[face + "_skill_path"]).read_bytes()
            self.assertEqual(DIAL.transform_access_policy(skill, updated="2030-01-01"), skill)

    def test_revise_new_package_is_already_unchanged_but_still_requires_its_key(self):
        pair = self.create_pair()
        before = self.snapshot()
        result = DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(self.snapshot(), before)
        key_path = self.keys / "kody-w-vb-atlas.ed25519.pem"
        key_path.unlink()
        before = self.snapshot()
        with self.assertRaises(ValueError):
            DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        self.assertEqual(self.snapshot(), before)

    def test_revised_pair_remains_compatible_with_mint_once_create_replay(self):
        pair = self.legacy_pair()
        DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        before = self.snapshot()
        self.assertEqual(self.create_pair(), pair)
        self.assertEqual(self.snapshot(), before)

    def test_revise_only_appends_a_frame_for_the_face_with_changed_policy(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        public_skill = directory / "public" / pair["public_skill_path"]
        self.publish_skill(pair, "public", DIAL.transform_access_policy(
            public_skill.read_bytes(), updated="2020-01-03"))
        binding = {name: pair[name] for name in DIAL.BINDING_KEYS}
        (directory / "public" / "index.html").write_bytes(DIAL._index(binding))
        before = self.snapshot()
        self.assertEqual(DIAL.verify_pair(directory, pair["estate_owner"])["status"], "verified")
        result = DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        self.assertEqual(result["faces_revised"], ["private"])
        for name in (pair["public_skill_path"], "FRAME.json", "FRAMES.jsonl", "registry.json", "rappid.json"):
            path = directory / "public" / name
            self.assertEqual(path.read_bytes(), before[path.relative_to(self.base)])
        self.assertEqual(DIAL.verify_pair(directory, pair["estate_owner"])["frames_checked"], 4)

    def test_revise_handles_canonical_files_without_a_terminal_lf(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        for path in directory.rglob("*"):
            if path.suffix == ".json" or path.name == "FRAMES.jsonl":
                path.write_bytes(path.read_bytes().removesuffix(b"\n"))
        before = self.snapshot()
        DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        for face in ("public", "private"):
            chain = directory / face / "FRAMES.jsonl"
            self.assertTrue(chain.read_bytes().startswith(before[chain.relative_to(self.base)] + b"\n"))
            registry = directory / face / "registry.json"
            self.assertEqual(registry.read_bytes(), before[registry.relative_to(self.base)])
        self.assertEqual(DIAL.verify_pair(directory, pair["estate_owner"])["status"], "verified")

    def test_revise_preserves_real_root_git_directories_and_closed_inventory(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        for root in (directory, directory / "public", directory / "private"):
            metadata = root / ".git" / "objects"
            metadata.mkdir(parents=True)
            (metadata / "synthetic-object").write_bytes(b"synthetic local git metadata\x00\xff")
        before = self.snapshot()
        DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        for path, data in before.items():
            if ".git" in path.parts:
                self.assertEqual(self.snapshot()[path], data)
        (directory / "public" / "unrecognized.txt").write_bytes(b"not a recognized publication artifact")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        self.assertEqual(self.snapshot(), before)

    def test_revise_refuses_wrong_owner_or_key_without_writing(self):
        pair = self.legacy_pair()
        other = self.create_pair("vb-forge")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            DIAL.revise_pair(pair["directory"], self.keys, other["estate_owner"])
        self.assertEqual(self.snapshot(), before)
        key = self.keys / "kody-w-vb-atlas.ed25519.pem"
        key.write_bytes((self.keys / "kody-w-vb-forge.ed25519.pem").read_bytes())
        before = self.snapshot()
        with self.assertRaises(ValueError):
            DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        self.assertEqual(self.snapshot(), before)

    def test_revise_refuses_bad_current_signatures_without_writing(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        clean = self.snapshot()
        for face, name in (("public", "DIAL.json"), ("private", "registry.json"),
                           ("public", "FRAME.json"), ("private", "FRAME.json")):
            for path, data in clean.items():
                (self.base / path).write_bytes(data)
            document_path = directory / face / name
            document = json.loads(document_path.read_bytes())
            document["sig"] = "invalid-signature"
            document_path.write_bytes(self.encode_json(document))
            if name == "FRAME.json":
                (directory / face / "FRAMES.jsonl").write_bytes(self.encode_json(document))
            before = self.snapshot()
            with self.subTest(face=face, name=name), \
                    mock.patch.object(DIAL, "_load_key", side_effect=AssertionError("verify before reading key")), \
                    self.assertRaises(ValueError):
                DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
            self.assertEqual(self.snapshot(), before)

    def test_revise_refuses_custom_or_conflicting_policy_without_replacing_it(self):
        pair = self.legacy_pair()
        path = Path(pair["directory"]) / "public" / pair["public_skill_path"]
        original = path.read_bytes()
        for changed in (
                original.replace(b"never automatic.", b"always automatic.", 1),
                original.replace(b"private-load: \"explicit\"", b"private-load: \"ask-first\"", 1),
                original.replace(b'private-load: "explicit"', b'private-load: "\\u0065xplicit"', 1),
                original.replace(LEGACY_ACCESS_POLICY.encode(), AUTOMATIC_ACCESS_POLICY.encode(), 1),
                original.replace(b"## What stays private",
                                 b"Use a different authorization policy.\n\n## What stays private", 1)):
            self.publish_skill(pair, "public", changed)
            before = self.snapshot()
            with self.assertRaises(ValueError):
                DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
            self.assertEqual(self.snapshot(), before)

    def test_revise_refuses_unsigned_local_memory_changes_without_erasing_them(self):
        pair = self.legacy_pair()
        path = Path(pair["directory"]) / "private" / pair["private_skill_path"]
        path.write_bytes(path.read_bytes() + b"\n- User learning not yet published.\n")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        self.assertEqual(self.snapshot(), before)

    def test_revise_refuses_unsafe_paths_symlinks_and_insecure_keys_without_writing(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        before = self.snapshot()
        for package, keys in ((directory / ".." / directory.name, self.keys),
                              (directory, directory / "keys"), (directory, directory.parent)):
            with self.subTest(package=package, keys=keys), self.assertRaises(ValueError):
                DIAL.revise_pair(package, keys, pair["estate_owner"])
            self.assertEqual(self.snapshot(), before)
        alias = self.base / "alias"
        for target, argument in ((directory, "directory"), (self.keys, "keys")):
            alias.symlink_to(target, target_is_directory=True)
            try:
                with self.assertRaises(ValueError):
                    DIAL.revise_pair(alias if argument == "directory" else directory,
                                     alias if argument == "keys" else self.keys, pair["estate_owner"])
            finally:
                alias.unlink()
            self.assertEqual(self.snapshot(), before)
        key_path = self.keys / "kody-w-vb-atlas.ed25519.pem"
        key_path.chmod(0o644)
        with self.assertRaises(ValueError):
            DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        self.assertEqual(self.snapshot(), before)
        key_path.chmod(0o600)
        for path in (key_path, directory / "private" / pair["private_skill_path"]):
            moved = self.base / "synthetic-symlink-target"
            path.rename(moved)
            path.symlink_to(moved)
            try:
                with self.assertRaises(ValueError):
                    DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
            finally:
                path.unlink()
                moved.rename(path)
            self.assertEqual(self.snapshot(), before)
        (directory / "public" / ".git").symlink_to(self.keys, target_is_directory=True)
        try:
            with self.assertRaises(ValueError):
                DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        finally:
            (directory / "public" / ".git").unlink()
        self.assertEqual(self.snapshot(), before)

    def test_revise_checks_the_complete_stage_before_installing_and_preserves_failure_bytes(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        before = self.snapshot()
        verify = DIAL.verify_pair
        stages = []

        def reject_stage(path, expected_owner):
            if Path(path) != directory:
                stages.append(Path(path))
                self.assertEqual(self.snapshot_subset(directory), {
                    relative: data for relative, data in before.items()
                    if relative.is_relative_to(directory.relative_to(self.base))})
                self.assertEqual(verify(path, expected_owner)["frames_checked"], 4)
                skill = Path(path) / "public" / pair["public_skill_path"]
                skill.write_bytes(skill.read_bytes() + b"\nStage corruption must be refused.\n")
            return verify(path, expected_owner)

        with mock.patch.object(DIAL, "verify_pair", side_effect=reject_stage), self.assertRaises(ValueError):
            DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        self.assertTrue(stages)
        self.assertTrue(all(not path.exists() for path in stages))
        self.assertEqual(self.snapshot(), before)

    def snapshot_subset(self, directory):
        return {path.relative_to(self.base): path.read_bytes()
                for path in directory.rglob("*") if path.is_file()}

    def test_revise_staging_copy_failure_never_changes_the_original_pair(self):
        pair = self.legacy_pair()
        before = self.snapshot()
        with mock.patch.object(DIAL.shutil, "copytree", side_effect=OSError("synthetic copy failure")), \
                self.assertRaises(OSError):
            DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(list(self.output.iterdir()), [Path(pair["directory"])])

    def test_revise_refuses_to_overwrite_memory_edited_while_staging(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        private_skill = directory / "private" / pair["private_skill_path"]
        before = self.snapshot()
        user_edit = private_skill.read_bytes() + b"\n- Learning saved while revision was staging.\n"
        verify = DIAL.verify_pair

        def edit_during_verification(path, expected_owner):
            verdict = verify(path, expected_owner)
            if Path(path) != directory:
                private_skill.write_bytes(user_edit)
            return verdict

        with mock.patch.object(DIAL, "verify_pair", side_effect=edit_during_verification), \
                self.assertRaises(ValueError):
            DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        before[private_skill.relative_to(self.base)] = user_edit
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(list(self.output.iterdir()), [directory])

    def test_revise_signing_failure_never_changes_the_original_pair(self):
        pair = self.legacy_pair()
        before = self.snapshot()
        sign = DIAL._sign
        calls = []

        def fail_second_signature(*args, **kwargs):
            calls.append(True)
            if len(calls) == 2:
                raise ValueError("synthetic signing failure")
            return sign(*args, **kwargs)

        with mock.patch.object(DIAL, "_sign", side_effect=fail_second_signature), self.assertRaises(ValueError):
            DIAL.revise_pair(pair["directory"], self.keys, pair["estate_owner"])
        self.assertEqual(self.snapshot(), before)

    def test_revise_install_failure_restores_the_original_directory(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        before = self.snapshot()
        rename = os.rename
        failed = []

        def fail_stage_install(source, target):
            if Path(target) == directory and not failed:
                failed.append(True)
                raise OSError("synthetic install failure")
            return rename(source, target)

        with mock.patch.object(DIAL.os, "rename", side_effect=fail_stage_install), self.assertRaises(OSError):
            DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        self.assertTrue(failed)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(DIAL.verify_pair(directory, pair["estate_owner"])["status"], "verified")

    def test_revise_never_leaks_private_fingerprints_into_public_artifacts_or_results(self):
        pair = self.legacy_pair()
        directory = Path(pair["directory"])
        private_before = json.loads((directory / "private" / "FRAME.json").read_bytes())
        result = DIAL.revise_pair(directory, self.keys, pair["estate_owner"])
        private_after = json.loads((directory / "private" / "FRAME.json").read_bytes())
        private_values = [DIAL.PRIVATE_TEST_MARKER]
        for frame in (private_before, private_after):
            private_values.extend((frame["frame_hash"], frame["payload_hash"], frame["payload"]["sha256"]))
        public_values = [path.read_bytes() for path in (directory / "public").rglob("*") if path.is_file()]
        public_values.append(json.dumps(result).encode())
        for content in public_values:
            for value in private_values:
                self.assertNotIn(value.encode(), content)

    def test_unsigned_publication_is_refused_even_when_frame_hash_is_valid(self):
        pair = self.create_pair()
        public = Path(pair["directory"]) / "public"
        original = json.loads((public / "FRAME.json").read_text())
        for sig in (None, "invalid-signature"):
            frame = dict(original, sig=sig)
            (public / "FRAMES.jsonl").write_bytes(self.encode_json(frame))
            (public / "FRAME.json").write_bytes(self.encode_json(frame))
            with self.subTest(sig=sig), self.assertRaises(ValueError):
                DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_signed_registry_requires_protocol_genesis_and_kind_binding(self):
        pair = self.create_pair()
        path = Path(pair["directory"]) / "public" / "registry.json"
        original = json.loads(path.read_text())
        for entry_type in ("protocol", "genesis", "kind"):
            document = copy.deepcopy(original)
            document["entries"] = [entry for entry in document["entries"] if entry["type"] != entry_type]
            path.write_bytes(self.encode_json(self.resign(document)))
            with self.subTest(entry_type=entry_type), self.assertRaises(ValueError):
                DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_registries_bind_exactly_the_three_used_chat_error_codes(self):
        pair = self.create_pair()
        expected = ["invalid-request", "unknown-session", "refused"]
        for face in ("public", "private"):
            path = Path(pair["directory"]) / face / "registry.json"
            original = json.loads(path.read_bytes())
            codes = [entry["code"] for entry in original["entries"] if entry["type"] == "error-code"]
            self.assertEqual(sorted(codes), sorted(expected))
            for mutation in ("missing", "extra", "duplicate"):
                document = copy.deepcopy(original)
                if mutation == "missing":
                    document["entries"] = [
                        entry for entry in document["entries"]
                        if entry != {"type": "error-code", "code": "invalid-request"}
                    ]
                else:
                    document["entries"].append({
                        "type": "error-code", "code": "unexpected" if mutation == "extra" else "refused",
                    })
                path.write_bytes(self.encode_json(self.resign(document)))
                try:
                    with self.subTest(face=face, mutation=mutation), self.assertRaises(ValueError):
                        DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])
                finally:
                    path.write_bytes(self.encode_json(original))

    def test_signed_receipt_cannot_redirect_or_substitute_private_data(self):
        pair = self.create_pair()
        directory = Path(pair["directory"])
        path = directory / "public" / "DIAL.json"
        original = json.loads(path.read_text())
        private_head = json.loads((directory / "private" / "FRAME.json").read_text())
        for field, value in (
            ("private_repo", "someone-else/private"),
            ("registry_url", "https://example.invalid/registry.json"),
            ("public_head", private_head),
            ("public_sha256", private_head["payload"]["sha256"]),
            ("entries_key", "untrusted_entries"),
        ):
            receipt = copy.deepcopy(original)
            receipt[field] = value
            encoded = self.encode_json(self.resign(receipt))
            path.write_bytes(encoded)
            (directory / "private" / "DIAL.json").write_bytes(encoded)
            with self.subTest(field=field), self.assertRaises(ValueError):
                DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_duplicate_json_members_and_unexpected_files_are_refused(self):
        pair = self.create_pair()
        public = Path(pair["directory"]) / "public"
        path = public / "DIAL.json"
        original = path.read_text()
        path.write_text('{"schema":"vbrainstem-dial/1",' + original.lstrip()[1:])
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])
        path.write_text(original)
        (public / "unreviewed.txt").write_text(DIAL.PRIVATE_TEST_MARKER)
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_keys_are_private_and_cannot_be_inside_output(self):
        with self.assertRaises(ValueError):
            DIAL.create_pair("vb-atlas", owner="kody-w", output=self.output, key_dir=self.output / "keys")
        self.assertFalse(self.output.exists())
        self.create_pair()
        key_files = list(self.keys.glob("*.pem"))
        self.assertEqual(len(key_files), 1)
        self.assertEqual(stat.S_IMODE(key_files[0].stat().st_mode), 0o600)
        self.assertEqual(key_files[0].stat().st_nlink, 1)
        self.assertEqual(len(list(self.keys.iterdir())), 1)

    def test_lost_key_is_not_silently_replaced(self):
        pair = self.create_pair()
        original = (Path(pair["directory"]) / "public" / "DIAL.json").read_bytes()
        next(self.keys.glob("*.pem")).unlink()
        with self.assertRaises(ValueError):
            self.create_pair()
        self.assertFalse(list(self.keys.glob("*.pem")))
        self.assertEqual((Path(pair["directory"]) / "public" / "DIAL.json").read_bytes(), original)

    def test_lost_package_is_not_silently_reminted_from_its_retained_key(self):
        pair = self.create_pair()
        key_path = next(self.keys.glob("*.pem"))
        original = key_path.read_bytes()
        shutil.rmtree(pair["directory"])
        with self.assertRaises(ValueError):
            self.create_pair()
        self.assertFalse(Path(pair["directory"]).exists())
        self.assertEqual(key_path.read_bytes(), original)

    def test_receipt_signature_is_required_independently_of_registry_and_frame(self):
        pair = self.create_pair()
        directory = Path(pair["directory"])
        original = json.loads((directory / "public" / "DIAL.json").read_text())
        for sig in (None, "invalid-signature"):
            receipt = dict(original, sig=sig)
            for face in ("public", "private"):
                (directory / face / "DIAL.json").write_bytes(self.encode_json(receipt))
            with self.subTest(sig=sig), self.assertRaises(ValueError):
                DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_chain_linkage_and_registered_genesis_are_checked(self):
        pair = self.create_pair()
        public = Path(pair["directory"]) / "public"
        frame = json.loads((public / "FRAME.json").read_text())
        skipped = DIAL.R.build_frame(
            kind=frame["kind"], stream_id=frame["stream_id"], seq=2, utc=frame["utc"],
            payload=frame["payload"], prev=frame["payload_hash"], sig=frame["sig"],
        )
        (public / "FRAMES.jsonl").write_bytes(self.encode_json(frame) + self.encode_json(self.resign(skipped)))
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])
        (public / "FRAMES.jsonl").write_bytes(self.encode_json(frame))
        registry = json.loads((public / "registry.json").read_text())
        for entry in registry["entries"]:
            if entry["type"] == "genesis":
                entry["frame_hash"] = "0" * 64
        (public / "registry.json").write_bytes(self.encode_json(self.resign(registry)))
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_no_identity_is_used_as_an_egg_ancestor(self):
        pair = self.create_pair()
        for face in ("public", "private"):
            identity = json.loads((Path(pair["directory"]) / face / "rappid.json").read_text())
            self.assertIsNone(identity["grown_from"])
        identity_path = Path(pair["directory"]) / "public" / "rappid.json"
        identity["rappid"] = pair["public_id"]
        identity["grown_from"] = pair["private_id"]
        identity_path.write_bytes(self.encode_json(identity))
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_unrecognized_or_insecure_key_is_refused(self):
        self.create_pair()
        key_path = next(self.keys.glob("*.pem"))
        original = key_path.read_bytes()
        key_path.write_text("not a signing key")
        with self.assertRaises(ValueError):
            self.create_pair()
        key_path.write_bytes(original)
        key_path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.create_pair()

    def test_symlinked_output_keys_or_artifacts_are_refused(self):
        elsewhere = self.base / "elsewhere"
        elsewhere.mkdir()
        self.output.symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.create_pair()
        self.assertFalse(list(elsewhere.iterdir()))
        self.output.unlink()
        self.keys.symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.create_pair()
        self.assertFalse(self.output.exists())
        self.keys.unlink()
        pair = self.create_pair()
        skill = Path(pair["directory"]) / "public" / "vb-atlas" / "SKILL.md"
        moved = elsewhere / "SKILL.md"
        skill.rename(moved)
        skill.symlink_to(moved)
        with self.assertRaises(ValueError):
            DIAL.verify_pair(pair["directory"], expected_owner=pair["estate_owner"])

    def test_cli_create_and_verify_use_the_same_gates(self):
        command = [sys.executable, "-B", str(ROOT / "tools" / "dial_pairs.py")]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        created = subprocess.run(command + [
            "create", "--slug", "vb-quill", "--owner", "kody-w",
            "--output", str(self.output), "--key-dir", str(self.keys),
        ], capture_output=True, text=True, env=env, check=True)
        pair = json.loads(created.stdout)
        verified = subprocess.run(command + [
            "verify", "--directory", pair["directory"], "--expected-owner", pair["estate_owner"],
        ], capture_output=True, text=True, env=env, check=True)
        self.assertEqual(json.loads(verified.stdout)["status"], "verified")

    def test_cli_revise_uses_the_same_gates_and_fails_closed(self):
        pair = self.legacy_pair()
        command = [sys.executable, "-B", str(ROOT / "tools" / "dial_pairs.py"),
                   "revise", "--directory", pair["directory"], "--key-dir", str(self.keys),
                   "--expected-owner", pair["estate_owner"]]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        revised = subprocess.run(command, capture_output=True, text=True, env=env, check=True)
        self.assertEqual(json.loads(revised.stdout)["status"], "revised")
        before = self.snapshot()
        repeated = subprocess.run(command, capture_output=True, text=True, env=env, check=True)
        self.assertEqual(json.loads(repeated.stdout)["status"], "unchanged")
        self.assertEqual(self.snapshot(), before)
        refused = subprocess.run(command[:-1] + ["not-an-owner"], capture_output=True,
                                 text=True, env=env)
        self.assertNotEqual(refused.returncode, 0)
        self.assertFalse(refused.stdout)
        self.assertEqual(json.loads(refused.stderr)["status"], "refused")
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
