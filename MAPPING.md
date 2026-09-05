# How the file does what a Brainstem does

A Brainstem is a small local server that, on every message, loads a persona, discovers whatever
tools are in a folder, injects memory, answers, and saves what it learned. The vbrainstem file
gives a person the same behavior with no server: each native tool decides for itself how to do
each step, and the file tells it what the steps are.

| What a Brainstem does each turn | Where it lives in the file | What the native tool does |
|---|---|---|
| Loads the persona (`soul.md`) | "Who I am", "How to help me", "What done means" | Reads the file at the start of every task |
| Discovers tools from `agents/*_agent.py`, fresh every request | "My tools": a list, each with where it lives or a link | Makes sure each listed tool is in its skills folder (fetching by link if missing); anything not listed is not used |
| Injects memory (`ContextMemory`) into every turn | "Memory" | Reads the section every task; that is `ContextMemory.system_context()` done by the AI |
| Saves what it learned (`ManageMemory`) | The rule in "How to keep this file current" | Appends one dated line the moment something durable is learned; that is `ManageMemory.perform()` with the file as its store |
| Ships factory tools in `agents/` (`ContextMemory`, `ManageMemory`, `HackerNews`) | Nothing to list; they are part of being a Brainstem | Offers all three from the first turn, simulated from the vendored code |
| Keeps a storage folder (`memory.json`, files tools write) | "Memory", "Memory (older)", and a "Storage" section on demand | Reads and writes those sections; the file is the storage |
| Unloads a tool when its file is removed | Removing a line from "My tools" | Stops using it on the next task |
| Runs a tool's code | The code inside each skill file | Runs it locally; if it cannot run code, reads the code and carries out what it does |
| Keeps a session | Nothing | The native tool's own session |
| Answers on one wire | Nothing | The native tool's own chat |

Every tool is one skill file. Every skill file converts to one Python file and back without loss
([rapp-skills](https://github.com/kody-w/rapp-skills)), so the same tool is an agent in a
Brainstem and a skill everywhere else. Dropping a person's tools, as `<tool>_agent.py` files,
directly into a Brainstem's `agents/` folder makes them native there too, with no restart (a
Brainstem loads only `agents/*_agent.py`; a bare `agent.py` is never found).

Nothing in the file itself names any of this. A person reads a page about themselves.
