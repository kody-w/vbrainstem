#!/usr/bin/env python3
"""Mint (or verify) a RAPP/1 frame that publishes a skill file, using the protocol's own reference code.

Usage:
  python3 tools/mint_frame.py mint   <skill-dir> [--kind skill.publish] [--rapp-py PATH]
  python3 tools/mint_frame.py verify <skill-dir> [--rapp-py PATH]

The frame lives beside the skill as FRAME.json; the stream identity is minted once and kept in
STREAM.json. Later revisions of the skill append seq+1 frames whose prev is the predecessor's
payload_hash (RAPP/1 section 7.4); each frame is verified against the head frame before it.
The reference implementation is kody-w/rapp-1's rapp.py (stdlib); pass --rapp-py or set RAPP_PY.
"""
import argparse, datetime as dt, hashlib, importlib.util, json, os, sys
from pathlib import Path


def load_rapp(path: str):
    spec = importlib.util.spec_from_file_location("rapp", path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["mint", "verify"])
    ap.add_argument("skill")
    ap.add_argument("--kind", default="skill.publish")
    ap.add_argument("--owner", default="kody-w")
    ap.add_argument("--rapp-py", default=os.environ.get("RAPP_PY", ""))
    a = ap.parse_args()
    if not a.rapp_py:
        print("pass --rapp-py <path to kody-w/rapp-1/rapp.py> or set RAPP_PY", file=sys.stderr); return 2
    R = load_rapp(a.rapp_py)
    skill = Path(a.skill); md = skill / "SKILL.md"
    data = md.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    stream_file = skill / "STREAM.json"; frame_file = skill / "FRAME.json"; chain = skill / "FRAMES.jsonl"
    if a.cmd == "verify":
        frame = json.loads(frame_file.read_text()); stream = json.loads(stream_file.read_text())["stream_id"]
        prev = None
        frames = [json.loads(l) for l in chain.read_text().splitlines() if l.strip()] if chain.exists() else [frame]
        for f in frames:
            ok, step, why = R.verify_frame(f, head=prev, stream_id_of_record=stream)
            if not ok:
                print(f"FAIL at seq {f['seq']}: {step}: {why}"); return 1
            prev = f
        match = frames[-1]["payload"]["sha256"] == sha
        print(f"OK {len(frames)} frame(s) verify; head {frames[-1]['frame_hash'][:16]}…; SKILL.md sha256 {'matches' if match else 'DIFFERS FROM'} the head frame")
        return 0 if match else 1
    if stream_file.exists():
        stream = json.loads(stream_file.read_text())["stream_id"]
    else:
        stream = R.mint_rappid(a.owner, skill.name)
        stream_file.write_text(json.dumps({"stream_id": stream, "minted_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "note": "minted once; never derived from the name"}, indent=2) + "\n")
    frames = [json.loads(l) for l in chain.read_text().splitlines() if l.strip()] if chain.exists() else []
    if frames and frames[-1]["payload"]["sha256"] == sha:
        print("no change since the last frame; nothing minted"); return 0
    head = frames[-1] if frames else None
    prev = head["payload_hash"] if head else None
    utc = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    payload = {"schema": "vbrainstem/1-skill", "name": skill.name, "path": f"{skill.name}/SKILL.md", "sha256": sha, "bytes": len(data),
               "url": f"https://raw.githubusercontent.com/{a.owner}/vbrainstem/main/{skill.name}/SKILL.md"}
    frame = R.build_frame(kind=a.kind, stream_id=stream, seq=len(frames), utc=utc, payload=payload, prev=prev)
    ok, step, why = R.verify_frame(frame, head=head, stream_id_of_record=stream)
    if not ok:
        print(f"refusing to write a frame that does not verify: {step}: {why}"); return 1
    with chain.open("a") as fh:
        fh.write(json.dumps(frame, separators=(",", ":"), sort_keys=True) + "\n")
    frame_file.write_text(json.dumps(frame, indent=2, sort_keys=True) + "\n")
    print(f"minted seq {frame['seq']} on {stream}\n  particle {frame['payload_hash']}\n  wave     {frame['frame_hash']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
