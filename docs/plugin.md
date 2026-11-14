# Aster as a Claude Code plugin

The MCP bridge of [`mcp.md`](mcp.md), packaged so it works in any repository on any computer:
install the plugin, open Claude Code in a repository that holds (or will hold) a model file, and
ask Claude to work on it. The model opens in a browser tab, Claude and you edit the same diagram,
and the file in the repository follows every change. Git is the source of truth; committing is
ordinary git.

## Install and use

```
/plugin marketplace add parsvensson/Aster
/plugin install aster@aster
```

Needs Node 24 or newer. Then, in any repository:

> Read src/billing and docs/architecture.md, then suggest changes to docs/model.mdj, view "alpha".

Claude calls `aster_open`, opens the URL it answers with (the desktop app's built-in browser pane,
or it hands you the URL), and works through the same `aster_*` tools as in `mcp.md`.

## How it works

```
Claude Code ──MCP over stdio──▶ plugin/server.js  (one Node process, started by the plugin)
                                    │  serves plugin/app (the built Aster) on http://127.0.0.1:4517
                                    │  /__bridge/events  server → tab   (an event stream)
                                    │  /__bridge/send    tab → server   (POST)
                                    ▼
                         the tab (src/lib/bridge/client.svelte.ts over src/lib/bridge/http.ts)
                                    │  reads the stores; every write is projectStore.run(batch, …)
                                    ▼
                         model ─▶ canvas, Outline, undo … and, after each change, the file's text
                                    │  aster:save
                                    ▼
                         plugin/server.js writes docs/model.mdj in the repository
```

- **One process.** `scripts/mcp/main.ts` is the MCP server Claude Code starts. The same process
  serves the app and the bridge on a local port (4517, or the next free one; `ASTER_PORT` sets
  it) with Node's own `http`: no WebSocket, no dependency at run time.
- **The file.** `aster_open { file, diagram? }` reads the file inside the repository (the
  session's folder; nothing outside it opens) and sends its text to the tab, which loads it as
  ⌘O would and shows the named diagram. A file that does not exist becomes a new project with one
  diagram of that name. From then on the tab sends the file's text 300 ms after every change and
  the server writes it, whole or not at all (a temporary file, renamed).
- **Changes from outside.** The server watches the open file. When git, StarUML or an editor
  changes it, the tab is sent the new text and reloads (the undo history starts over). A save the
  tab made from the older text is refused, so the disk always wins.
- **Tabs.** A tab that connects, or is reloaded, is sent the open file once. A tab the user then
  points at another project is left alone, and stops saving to the file.
- **The same tools.** Everything in `mcp.md` applies: the same server code (`scripts/mcp/server.ts`),
  the same handler in the tab. `aster_open` is the one tool the plugin adds.
- **Who is allowed in.** The port is bound to 127.0.0.1, requests must name a local host, and the
  bridge paths refuse requests that carry another site's origin, so a page of another site open
  in the same browser cannot reach it.
- **The built app only wakes the bridge on a local host**, and only when `/__bridge/ping`
  answers. On asteruml.app the code is a lazy chunk that is never fetched.
- **No offline cache** when served by the plugin: the server answers `/service-worker.js` with a
  worker that does nothing, so a plugin update is never hidden behind a cached app.

## What is checked in

`plugin/` is the plugin as Claude Code installs it (it clones the repository and reads this
folder; nothing is built on install):

| Path                              | Source                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| `.claude-plugin/marketplace.json` | The repository as a marketplace with one plugin, `./plugin`.    |
| `plugin/.claude-plugin/`          | Manifest and icon.                                              |
| `plugin/.mcp.json`                | `node ${CLAUDE_PLUGIN_ROOT}/server.js`.                         |
| `plugin/skills/uml-modelling/`    | The workflow Claude follows.                                    |
| `plugin/server.js`                | Generated: `scripts/mcp/main.ts` bundled with its dependencies. |
| `plugin/app/`                     | Generated: `pnpm build`'s output.                               |

After a change to the app or to `scripts/mcp/`, run `pnpm plugin:build` and commit `plugin/`
with it, and raise `version` in `plugin/.claude-plugin/plugin.json` so installed copies update.

## Git

- The first save of a file StarUML wrote reorders some keys: on the 5 000-line fixture
  `public-ffdb.mdj`, 143 lines once. After that an unchanged model serialises to the same bytes,
  so diffs show real changes only.
- Positions are part of the file: moving a class is a diff.
- Do not edit the file with other tools while it is open in the tab unless you mean to: the tab
  reloads to match.

## Tests

`tests/unit/bridge-standalone.test.ts` runs the whole server against a temporary folder: an MCP
client, a tab speaking the HTTP channel and answering with the real handler, the files under it.
The tab's own side (`client.svelte.ts`, `http.ts`) needs a browser and is checked by hand: open a
file, edit by MCP and by hand, `git checkout` another version, reload the tab.
