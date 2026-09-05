"""The vendored kernel is whole: every block hashes, the factory tools are there, the words match the code."""
import hashlib, re, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "virtual-brainstem" / "SKILL.md").read_text(encoding="utf-8")
CONSTITUTION = (ROOT / "CONSTITUTION.md").read_text(encoding="utf-8")
BLOCK_RE = re.compile(r"<!-- kernel file=(\S+) sha256=([0-9a-f]{64}) source=(\S+)(?: path=\S+)? -->\n(`{3,})(\w*)\n(.*?)\n\4\n<!-- /kernel -->", re.S)
FACTORY = {"context_memory_agent.py": "ContextMemory", "manage_memory_agent.py": "ManageMemory", "hacker_news_agent.py": "HackerNews", "rar_rapp_learn_new_agent.py": "LearnNew"}


def blocks():
    return {m.group(1): (m.group(2), m.group(6)) for m in BLOCK_RE.finditer(SKILL)}


class VendoredKernel(unittest.TestCase):
    def test_every_block_hashes_to_its_marker(self):
        found = blocks()
        self.assertGreaterEqual(len(found), 10)
        for path, (digest, body) in found.items():
            ok = any(hashlib.sha256(c.encode("utf-8")).hexdigest() == digest for c in (body + "\n", body))
            self.assertTrue(ok, path)

    def test_factory_agents_are_vendored_and_named_as_the_code_names_them(self):
        found = blocks()
        for filename, tool in FACTORY.items():
            path = "rapp_brainstem/agents/" + filename
            self.assertIn(path, found, path)
            body = found[path][1]
            self.assertRegex(body, rf"self\.name = ['\"]{tool}['\"]", f"{filename} must define the tool {tool}")
            # the simulation section names the tool and its file
            section = SKILL.split("## 2g. Factory tools, run in the virtual machine", 1)[1].split("## 2h.", 1)[0]
            self.assertIn(f"**{tool}**", section)
            self.assertIn(f"`agents/{filename}`", section)

    def test_simulation_quotes_the_code_strings_verbatim(self):
        found = blocks()
        manage = found["rapp_brainstem/agents/manage_memory_agent.py"][1]
        context = found["rapp_brainstem/agents/context_memory_agent.py"][1]
        section = SKILL.split("## 2g. Factory tools, run in the virtual machine", 1)[1].split("## 2h.", 1)[0]
        for literal in ["Error: No content provided for memory storage.", "Successfully stored "]:
            self.assertIn(literal, manage); self.assertIn(literal, section)
        for literal in ["All memories ", "No matching memories found.", "I don't have any memories stored in the shared memory yet.", "- Memory content (verbatim): "]:
            self.assertIn(literal, context); self.assertIn(literal, section.replace("\n  ", " ").replace("\n", " ") if literal.startswith("I don't") else section)

    def test_health_lists_factory_tools_first(self):
        self.assertIn('"agents": ["ContextMemory", "HackerNews", "ManageMemory", "LearnNew", "ToolName", ...]', SKILL)

    def test_constitution_is_mirrored(self):
        embedded = re.findall(r"^### ([IVXL]+\. .+)$", SKILL, re.M)
        standalone = re.findall(r"^## ([IVXL]+\. .+)$", CONSTITUTION, re.M)
        self.assertEqual(embedded, standalone)
        self.assertIn("XVII. A factory Brainstem, run in a virtual machine", standalone)
        for title in standalone:
            e = SKILL.split("### " + title, 1)[1].split("\n### ", 1)[0].split("\n## ", 1)[0].strip()
            c = CONSTITUTION.split("## " + title, 1)[1].split("\n## ", 1)[0].strip()
            self.assertEqual(e, c, title)

    def test_fidelity_transcript_shows_the_factory_tools_at_work(self):
        import json
        fid = json.loads((ROOT / "virtual-brainstem" / "fidelity.json").read_text(encoding="utf-8"))
        self.assertIn("ContextMemory", fid["health"]["agents"])
        self.assertIn("ManageMemory", fid["health"]["agents"])
        logs = "\n".join(e["response"]["agent_logs"] for e in fid["exchange"])
        self.assertIn("[ManageMemory] Successfully stored", logs)
        self.assertIn("[ContextMemory] ", logs)

    def test_plant_maps_memory_lines_one_to_one_and_back(self):
        import subprocess, sys, tempfile, json, os
        m = re.search(r"<!-- plant-memory -->\n```python\n(.*?)\n```\n<!-- /plant-memory -->", SKILL, re.S)
        self.assertIsNotNone(m)
        found = blocks()
        with tempfile.TemporaryDirectory() as tmp:
            kernel = Path(tmp) / "rapp_brainstem"; (kernel / "agents").mkdir(parents=True)
            for p in ("rapp_brainstem/local_storage.py", "rapp_brainstem/agents/basic_agent.py", "rapp_brainstem/agents/context_memory_agent.py"):
                (Path(tmp) / p).write_text(found[p][1] + "\n", encoding="utf-8")
            plant = Path(tmp) / "plant_memory.py"; plant.write_text(m.group(1), encoding="utf-8")
            person = Path(tmp) / "SKILL.md"
            person.write_text(["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "vb-plant"', '  owner: "Ada"', '  created: "2026-09-01"', '  updated: "2026-09-05"', "---", "", "# Ada", "", "## Memory", "",
                               "- 2026-09-05 14:03:11 Favorite bread is rye (preference, importance 4, tags: food, bakery)", "- 2026-09-04 Spring menu drafted.", "", "## Memory (older)", "", "- 2026-09-02 Opened at 6.", "", "## Storage", "", "### notes/hours.txt", "", "```text", "Open at 6.", "```", "", "### agents/made_up_agent.py", "", "```python", "from agents.basic_agent import BasicAgent", "class MadeUpAgent(BasicAgent):", "    def __init__(self):", "        self.name = 'MadeUp'; self.metadata = {'name': self.name, 'description': 'x', 'parameters': {'type': 'object', 'properties': {}}}", "        super().__init__(self.name, self.metadata)", "    def perform(self, **kwargs):", "        return 'made up'", "```", ""].join("\n") if False else "\n".join(["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "vb-plant"', '  owner: "Ada"', '  created: "2026-09-01"', '  updated: "2026-09-05"', "---", "", "# Ada", "", "## Memory", "",
                               "- 2026-09-05 14:03:11 Favorite bread is rye (preference, importance 4, tags: food, bakery)", "- 2026-09-04 Spring menu drafted.", "", "## Memory (older)", "", "- 2026-09-02 Opened at 6.", "", "## Storage", "", "### notes/hours.txt", "", "```text", "Open at 6.", "```", "", "### agents/made_up_agent.py", "", "```python", "from agents.basic_agent import BasicAgent", "class MadeUpAgent(BasicAgent):", "    def __init__(self):", "        self.name = 'MadeUp'; self.metadata = {'name': self.name, 'description': 'x', 'parameters': {'type': 'object', 'properties': {}}}", "        super().__init__(self.name, self.metadata)", "    def perform(self, **kwargs):", "        return 'made up'", "```", ""]), encoding="utf-8")
            r = subprocess.run([sys.executable, str(plant), str(kernel), str(person)], capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("memory: 3 record(s) written, 0 already there", r.stdout)
            self.assertTrue((kernel / "agents" / "made_up_agent.py").is_file())
            store = json.loads((kernel / ".brainstem_data" / "shared_memories" / "memory.json").read_text(encoding="utf-8"))
            recs = sorted(store.values(), key=lambda v: (v["date"], v["time"]), reverse=True)
            self.assertEqual([v["message"] for v in recs], ["Favorite bread is rye", "Spring menu drafted.", "Opened at 6."])
            self.assertEqual((recs[0]["theme"], recs[0]["importance"], recs[0]["tags"], recs[0]["time"]), ("preference", 4, ["food", "bakery"], "14:03:11"))
            self.assertEqual((recs[1]["theme"], recs[1]["importance"], recs[1]["tags"]), ("fact", 3, []))
            self.assertEqual((kernel / ".brainstem_data" / "notes" / "hours.txt").read_text(encoding="utf-8"), "Open at 6.\n")
            # planting twice writes nothing twice
            r = subprocess.run([sys.executable, str(plant), str(kernel), str(person)], capture_output=True, text=True, timeout=120)
            self.assertIn("memory: 0 record(s) written, 3 already there", r.stdout)
            # the real ContextMemory recalls every planted line, in the file's order
            probe = "import sys, types; sys.path.insert(0, %r); import local_storage; sys.modules['utils'] = types.ModuleType('utils'); sys.modules['utils.azure_file_storage'] = local_storage; import agents.context_memory_agent as c; print(c.ContextMemoryAgent().perform())" % str(kernel)
            r = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, timeout=120, cwd=str(kernel))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("All memories from shared memory:", r.stdout)
            self.assertLess(r.stdout.index("Favorite bread is rye"), r.stdout.index("Spring menu drafted."))
            self.assertLess(r.stdout.index("Spring menu drafted."), r.stdout.index("Opened at 6."))
            # and back: export prints each record as one line in the full form
            r = subprocess.run([sys.executable, str(plant), str(kernel), str(person), "--export"], capture_output=True, text=True, timeout=120)
            self.assertIn("- 2026-09-05 14:03:11 Favorite bread is rye (preference, importance 4, tags: food, bakery)", r.stdout)
            self.assertIn("Spring menu drafted.", r.stdout)

    def test_drift_check_harness_runs_a_vendored_agent_for_real(self):
        import subprocess, sys, tempfile, json
        m = re.search(r"<!-- drift-check -->\n```python\n(.*?)\n```\n<!-- /drift-check -->", SKILL, re.S)
        self.assertIsNotNone(m)
        with tempfile.TemporaryDirectory() as tmp:
            harness = Path(tmp) / "drift_check.py"; harness.write_text(m.group(1), encoding="utf-8")
            person = Path(tmp) / "SKILL.md"
            person.write_text((ROOT / "samples" / "ada" / "SKILL.md").read_text(encoding="utf-8"), encoding="utf-8")
            r = subprocess.run([sys.executable, str(harness), str(ROOT / "virtual-brainstem" / "SKILL.md"), str(person), "ManageMemory", json.dumps({"memory_type": "preference", "content": "Favorite bread is rye", "importance": 4})], capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('RESULT: Successfully stored preference memory in shared memory: "Favorite bread is rye"', r.stdout)
            self.assertIn('"message": "Favorite bread is rye"', r.stdout)
            r2 = subprocess.run([sys.executable, str(harness), str(ROOT / "virtual-brainstem" / "SKILL.md"), str(person), "ContextMemory", "{}"], capture_output=True, text=True, timeout=120)
            self.assertEqual(r2.returncode, 0, r2.stderr)
            self.assertIn("RESULT: All memories from shared memory:", r2.stdout)

if __name__ == "__main__":
    unittest.main()
