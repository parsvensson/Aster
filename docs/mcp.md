# Co-creating with Claude Code: the MCP bridge

With `pnpm dev` running and a diagram open in the browser, a Claude Code session in this
repository can read the model and change it, while you keep editing the same diagram. Every
change Claude makes is an undo step in your tab, labelled "… via MCP". The design and the
remaining slices are in [`mcp-bridge.md`](mcp-bridge.md).

## Connect

1. `pnpm dev`, then open `http://localhost:5173/` and a project (`/design/<slug>`).
2. Open Claude Code in this folder. It reads [`.mcp.json`](../.mcp.json) and connects to
   `http://localhost:5173/__mcp`; `/mcp` in Claude Code lists `aster` as connected.
3. Ask away: "what's in the diagram?", "add a Payment class that Order composes", "tidy the
   members of Account".

Nothing is installed or configured beyond that. The bridge answers the local computer only.
Outside this repository the same bridge comes as a Claude Code plugin that also keeps a model
file on disk in step with the tab: see [`plugin.md`](plugin.md).

## Tools

Read:

| Tool                  | Does                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aster_status`        | The open project: name, file, diagrams (id, name, kind, element count), the active diagram, the selection, whether something is being edited inline, undo and redo labels, element counts, the model version. |
| `aster_get_text`      | One diagram as PlantUML (the Text view's dialect, round-trips) or Mermaid (read-only). `diagram` is an id or a unique name; the active diagram when omitted.                                                  |
| `aster_get_project`   | The whole model as `.aster` JSON (layouts on request), plus `hidden`: the elements no diagram shows, flagged when unseen content (other StarUML diagram types, tags) still refers to them.                    |
| `aster_get_element`   | One element in full, which diagrams show it and where, and every relationship that touches it.                                                                                                                |
| `aster_find`          | Elements by name, kind, stereotype, diagram, or only the hidden ones.                                                                                                                                         |
| `aster_get_selection` | What the user has selected right now.                                                                                                                                                                         |
| `aster_validate`      | The Validation panel's findings, in its words.                                                                                                                                                                |
| `aster_render`        | The diagram, or part of it, as a PNG image (so Claude can look at it) or SVG text.                                                                                                                            |
| `aster_changes_since` | The commands run after a model version, the user's own included, answered by the dev server.                                                                                                                  |

Write, each one undo step labelled "… via MCP":

| Tool                   | Does                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aster_set_text`       | Makes a diagram match a PlantUML document. Classes the text still names keep id, position and documentation; a class the text drops leaves the diagram; `expectVersion` refuses the write when you edited in between. |
| `aster_add_to_diagram` | Gives elements that exist in the model a view on a diagram, at given positions or in free space, with the model's relationships between them drawn.                                                                   |
| `aster_delete`         | Deletes elements from the model (with the lines that touch them) or removes their views from one diagram.                                                                                                             |

## How it works

```
Claude Code ──MCP over HTTP──▶ vite dev (scripts/mcp/plugin.ts)
                                   │ HMR socket: aster:req / aster:res / aster:hello / aster:changed
                                   ▼
                        the tab (src/lib/bridge/client.svelte.ts)
                                   │ reads the stores; every write is projectStore.run(batch, …)
                                   ▼
                        model ─▶ canvas, Outline, Text view, undo, autosave, live region
```

- `src/lib/bridge/protocol.ts` is the contract both sides import; `handle.ts` does the work as
  pure functions over the model, so `tests/unit/bridge.test.ts` runs it with a project and a
  command stack and no browser. `tests/unit/bridge-server.test.ts` drives the real MCP server
  through an in-memory transport against a tab stood in by the same handler.
- The tab that said hello last (on connect, on focus, when it becomes visible, when a project
  opens) is the one that answers. Open two tabs and the one you click into takes over;
  `aster_status` lists them all and `aster_use_tab` picks one by url, route or project name.
- When the dev server restarts (it does whenever `scripts/mcp/` changes), it asks every socket
  that connects who it is, and the tabs say hello again. A tab Chrome has put to sleep in the
  background answers when it is next brought to the front.
- A tool call waits ten seconds for the tab, then fails with a message that says so.
- `tests/unit/bridge-plugin.test.ts` runs the whole chain against a real Vite dev server: an MCP
  client over HTTP, the plugin, the HMR socket, a tab answering with the real handler.
