"""The page's runner shim must be the converter's shim, byte for byte."""
import os
import re
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE_RE = re.compile(r"const SHIM_SOURCE = String\.raw`\n(.*?)\n`;", re.S)

TWO_AGENTS = (
    "from agents.basic_agent import BasicAgent\n"
    "class A(BasicAgent):\n"
    "    def __init__(self):\n"
    "        self.name = 'A'\n"
    "        self.metadata = {'name': 'A', 'description': 'a', 'parameters': {'type': 'object', 'properties': {}, 'required': []}}\n"
    "        super().__init__(self.name, self.metadata)\n"
    "    def perform(self, **k):\n"
    "        return 'A!'\n"
    "class B(BasicAgent):\n"
    "    def __init__(self):\n"
    "        self.name = 'B'\n"
    "        self.metadata = {'name': 'B', 'description': 'b', 'parameters': {'type': 'object', 'properties': {}, 'required': []}}\n"
    "        super().__init__(self.name, self.metadata)\n"
    "    def perform(self, **k):\n"
    "        return 'B!'\n"
)


class ShimParity(unittest.TestCase):
    def test_page_shim_equals_vendored_copy(self):
        page = (ROOT / "index.html").read_text(encoding="utf-8")
        m = PAGE_RE.search(page)
        self.assertIsNotNone(m, "index.html must embed SHIM_SOURCE as a String.raw template")
        vendored = (ROOT / "tools" / "shim_source.py").read_text(encoding="utf-8")
        self.assertEqual(m.group(1) + "\n", vendored, "run python3 tools/sync_shim.py")

    def test_vendored_shim_selects_tools_by_name_and_refuses_escapes(self):
        ns = {}
        exec(compile((ROOT / "tools" / "shim_source.py").read_text(encoding="utf-8"), "shim", "exec"), ns)
        ns["install_shims"]()
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["AGENT_STORAGE"] = tmp
            store = ns["AzureFileStorageManager"]()
            with self.assertRaises(ValueError):
                store.write_file("../escape.txt", "x")
            with self.assertRaises(ValueError):
                store.set_memory_context("..")
            agent = Path(tmp) / "agent.py"
            agent.write_text(TWO_AGENTS, encoding="utf-8")
            self.assertEqual(ns["load_agent"](agent, "A")[1].perform(), "A!")
            self.assertEqual(ns["load_agent"](agent, "B")[1].perform(), "B!")
            with self.assertRaises(RuntimeError):
                ns["load_agent"](agent, "C")


if __name__ == "__main__":
    unittest.main()
