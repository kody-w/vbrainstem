"""Release gates for the four synthetic, separately published AI pairs."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import unittest
from urllib.parse import parse_qs, urlsplit
import uuid

from cryptography.hazmat.primitives import serialization


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dial_pairs", ROOT / "tools" / "dial_pairs.py")
DIAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAL)


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

    def test_catalog_has_four_distinct_synthetic_roles(self):
        catalog = DIAL.load_catalog()
        self.assertEqual(set(catalog), {"vb-atlas", "vb-forge", "vb-quill", "vb-harbor"})
        self.assertEqual(len({entry["role"] for entry in catalog.values()}), 4)
        for entry in catalog.values():
            self.assertTrue(entry["name"])
            self.assertTrue(entry["description"])
            self.assertTrue(entry["sample_prompt"])

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
        self.assertEqual(len(identities), 12)

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

    def test_signed_dial_receipt_and_public_only_redirect(self):
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
            "face": ["public"], "trust": [pair["estate_owner"]],
        })
        index = (public / "index.html").read_text(encoding="utf-8")
        self.assertIn("face=public", index)
        self.assertNotIn("face=private", index)

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


if __name__ == "__main__":
    unittest.main()
