import json as _json, os as _os, sys as _sys, types as _types
from pathlib import Path as _Path


class BasicAgent:
    """BasicAgent contract: name, metadata, perform(**kwargs), to_tool()."""

    def __init__(self, name=None, metadata=None):
        if name is not None:
            self.name = name
        elif not hasattr(self, "name"):
            self.name = "BasicAgent"
        if metadata is not None:
            self.metadata = metadata
        elif not hasattr(self, "metadata"):
            self.metadata = {
                "name": self.name,
                "description": "Base agent -- override this.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            }

    def perform(self, **kwargs):
        return "Not implemented."

    def system_context(self):
        return None

    def to_tool(self):
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.metadata.get("description", ""),
                "parameters": self.metadata.get("parameters", {"type": "object", "properties": {}}),
            },
        }


class AzureFileStorageManager:
    """Local stand-in for the cloud storage helper some agents import.

    Used only if the agent itself saves something. Everything goes under one
    folder, $AGENT_STORAGE (default ~/.agent-storage); delete it to erase all of it.
    """

    def __init__(self, share_name=None, **kwargs):
        root = _os.environ.get("AGENT_STORAGE") or str(_Path.home() / ".agent-storage")
        self.root = _Path(root) / (share_name or "default")
        self.root.mkdir(parents=True, exist_ok=True)
        self._context = ""

    def set_memory_context(self, user_guid=None):
        self._context = user_guid or ""

    def _path(self, file_path):
        p = self.root / self._context / (file_path or "memory.json")
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def read_json(self, file_path=None):
        p = self._path(file_path)
        return _json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}

    def write_json(self, data, file_path=None):
        self._path(file_path).write_text(_json.dumps(data, indent=2), encoding="utf-8")
        return True

    def update_json(self, update_fn, file_path=None):
        data = update_fn(self.read_json(file_path))
        self.write_json(data, file_path)
        return data

    def read_file(self, file_path):
        p = self._path(file_path)
        return p.read_text(encoding="utf-8") if p.exists() else None

    def write_file(self, file_path, content):
        self._path(file_path).write_text(content, encoding="utf-8")
        return True

    def list_files(self, directory=""):
        d = self.root / self._context / directory
        return [x.name for x in d.iterdir()] if d.exists() else []

    def delete_file(self, file_path):
        p = self._path(file_path)
        if p.exists():
            p.unlink()
            return True
        return False

    def file_exists(self, file_path):
        return self._path(file_path).exists()


def install_shims():
    """Make `agents.basic_agent` and `utils.azure_file_storage` importable."""
    if "agents.basic_agent" not in _sys.modules:
        agents_mod = _types.ModuleType("agents")
        agents_mod.__path__ = []
        ba_mod = _types.ModuleType("agents.basic_agent")
        ba_mod.BasicAgent = BasicAgent
        agents_mod.basic_agent = ba_mod
        _sys.modules.setdefault("agents", agents_mod)
        _sys.modules["agents.basic_agent"] = ba_mod
    if "utils.azure_file_storage" not in _sys.modules:
        utils_mod = _sys.modules.get("utils") or _types.ModuleType("utils")
        if not hasattr(utils_mod, "__path__"):
            utils_mod.__path__ = []
        st_mod = _types.ModuleType("utils.azure_file_storage")
        st_mod.AzureFileStorageManager = AzureFileStorageManager
        utils_mod.azure_file_storage = st_mod
        _sys.modules.setdefault("utils", utils_mod)
        _sys.modules["utils.azure_file_storage"] = st_mod


def load_agent(path):
    """Import an agent file by path and return (module, agent instance)."""
    install_shims()
    path = _Path(path).resolve()
    spec = __import__("importlib.util").util.spec_from_file_location("skill_agent_" + path.stem, path)
    module = __import__("importlib.util").util.module_from_spec(spec)
    _sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    base = _sys.modules["agents.basic_agent"].BasicAgent
    candidates = [
        obj for obj in vars(module).values()
        if isinstance(obj, type) and issubclass(obj, base) and obj is not base
        and obj.__module__ == module.__name__
    ]
    if not candidates:
        raise RuntimeError(f"{path.name}: no BasicAgent subclass found")
    return module, candidates[-1]()


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Run this skill's agent locally.")
    ap.add_argument("--json", default=None, help="arguments as a JSON object")
    ap.add_argument("--describe", action="store_true", help="print the agent's tool definition")
    ap.add_argument("pairs", nargs="*", help="key=value arguments (alternative to --json)")
    args = ap.parse_args(argv)
    here = _Path(__file__).resolve().parent
    module, agent = load_agent(here / "agent.py")
    if args.describe:
        print(_json.dumps(agent.to_tool(), indent=2))
        return 0
    kwargs = _json.loads(args.json) if args.json else {}
    for pair in args.pairs:
        key, _, value = pair.partition("=")
        kwargs[key] = value
    result = agent.perform(**kwargs)
    if isinstance(result, (dict, list)):
        print(_json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(result if result is not None else "")
    return 0


if __name__ == "__main__":
    _sys.exit(main())
