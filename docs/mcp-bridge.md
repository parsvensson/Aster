# MCP bridge: Claude Code and the open Aster tab

A proposal, 14 Nov 2026. All four slices of the build plan below are built: see [`mcp.md`](mcp.md) for how to connect and what the tools do. The goal: with `pnpm dev` running and a
diagram open in the browser, a Claude Code session in this repository can read the model, change
it through the same commands the UI uses, and see the result, while the person keeps editing the
same diagram. Co-creation, not generation: Claude's edits land as undo steps next to the user's.

## What the codebase already gives us

Reading the code, the bridge is mostly plumbing. Six things the architecture already does make
the rest small:

1. **Commands are data.** Every edit is a `SerialisedCommand` `{ id, args }`, re-hydrated by
   `src/lib/commands/registry.ts`. The undo stack is stored in IndexedDB in exactly that form.
   The wire format between an external agent and the tab therefore already exists; nothing has
   to be invented, and anything Claude sends replays through `projectStore.run`, so it gets undo,
   autosave, the dirty dot, and the `aria-live` announcement ("Created class Order") for free.
2. **The whole model is one JSON document.** `serializeAster(project)` in `src/lib/aster/` is
   the full-fidelity snapshot with a published JSON Schema (`static/schema/v1.json`). That is the
   read side of the bridge, and the schema can be handed to Claude as documentation.
3. **A diff-and-apply for text already exists.** `planSync` in `src/lib/puml/sync.ts` takes a
   PlantUML document and the open diagram and produces one batch command that keeps ids, layout,
   documentation and roles for everything the text still names. "Here is the diagram as I want
   it" becomes a single undo step. This is the headline tool.
4. **The model and commands are pure TypeScript.** No Svelte imports (CLAUDE.md rule 1). The
   high-level tool handlers can be written as `(project, args) => SerialisedCommand[]` and unit
   tested in vitest without a browser, the same way `puml/sync.ts` is tested today.
5. **Rendering is pure too.** `diagramToSvg` in `src/lib/export/svg.ts` draws the diagram from
   the model plus node rectangles, and `svgToPng` turns it into pixels. Claude can be shown the
   diagram as an image after each change, which is what makes "does this look right?" possible.
6. **The dev server already has a socket into the tab.** `vite dev` keeps an HMR WebSocket open
   to every page, and Vite plugins may send and receive custom events on it. In production
   `import.meta.hot` is undefined and the code is dropped, so the bridge cannot ship by accident.

Also useful: `selection.svelte.ts` knows what the user has selected, so "make this one abstract"
has a referent; `validate()` in `src/lib/model/validate.ts` gives Claude the same findings the
Validation panel shows; `canvasApi.centreOn(id)` lets Claude point the user's eyes at something.

## Recommended shape

One process, one port, no new runtime dependency in the app.

```
Claude Code ──MCP, Streamable HTTP──▶ vite dev  (plugin: aster-mcp)
             http://localhost:5173/__mcp         │
                                                 │ HMR WebSocket, custom events `aster:req` / `aster:res`
                                                 ▼
                                   browser tab: src/lib/bridge/client.svelte.ts
                                                 │ reads stores; every write is projectStore.run(...)
                                                 ▼
                                   model ─▶ canvas, Outline, Text view, undo, autosave, live region
```

- **A Vite plugin** (`vite-plugin-aster-mcp.ts`, dev only) does three things: it hosts an MCP
  server over Streamable HTTP on `/__mcp` using `@modelcontextprotocol/sdk`'s Node transport
  mounted as Connect middleware in `configureServer`; it brokers request/response pairs to the
  tab over Vite's HMR channel (`server.ws.send(event, payload)`, `server.ws.on(event, (data,
client) => …)`, `client.send(…)`); and it keeps a small change log the tab reports into
  (version, label, touched ids) so Claude can ask "what changed since I last looked?".
- **A client module** in the app, `src/lib/bridge/client.svelte.ts`, mounted from
  `src/routes/+layout.svelte` only when `import.meta.hot` exists. It listens for `aster:req`,
  answers from the stores, and runs writes through `projectStore.run`. It never touches the model
  or Svelte Flow directly (rule 1), never bypasses the registry, and sends `aster:changed` after
  every version bump.
- **Pure handlers** in `src/lib/bridge/handlers.ts`: for each high-level tool, a function from
  `(project, diagram, args)` to a `BatchArgs` or a `SerialisedCommand[]`. Same pattern as
  `planSync`. Unit tested with the undo round trip from `tests/unit/commands.test.ts`.
- **`.mcp.json`** at the repository root:
  `{ "mcpServers": { "aster": { "type": "http", "url": "http://localhost:5173/__mcp" } } }`.
  Claude Code picks it up when opened in the repo, no `claude mcp add` needed. `vite.config.ts`
  gets `server: { port: 5173, strictPort: true }` so the URL is stable.

Alternatives considered and set aside:

| Option                                                                | Why not                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stdio MCP server spawned by Claude Code with its own WebSocket port | A second process and a second port to configure; Node has no built-in WebSocket server, so it needs `ws` or a hand-rolled one; the tab has to find the port. The Vite route is one process and already connected. |
| Driving the UI with Playwright from the MCP server                    | Slow, brittle, blind to the model; and it would need the e2e build, not the dev tab the person is looking at.                                                                                                     |
| Watching the `.aster` file on disk and having the tab reload it       | The tab cannot be told to re-read a File System Access handle; every change becomes "reload the project" and undo granularity is lost.                                                                            |
| The bridge in the deployed app behind an opt-in                       | Later, if wanted: the same client module could connect to a local MCP process when a flag is set. Not needed for the local co-creation case and widens the attack surface.                                        |

## The MCP surface

Names and ids: every tool that takes an element accepts an id or a unique name
(`"Order"`, `"Shop::Order"` for a packaged one); an ambiguous name is an error that lists the
candidates. Every write returns the new `version`, the undo label it made, and the ids it
touched. Writes are one undo step each, labelled through i18n with a prefix so the history reads
"Claude: add class Order" (rule 9: a `cmd.bridge` message key).

### Read

| Tool                  | Returns                                                                                                                      | Where it comes from                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `aster_status`        | connected tab(s), project name, open file and format, dirty, active diagram, diagram list, undo/redo labels, counts, version | `projectStore`, `files`, `persist`              |
| `aster_get_text`      | the active (or named) diagram as PlantUML, or Mermaid                                                                        | `printDiagram`, `diagramToMermaid`              |
| `aster_get_project`   | the `.aster` JSON; optional `diagramId` to trim to one diagram's elements; optional `fields` to drop layout                  | `serializeAster`                                |
| `aster_get_element`   | one element with its members, relationships touching it, and its layout on the active diagram                                | `project.elements`, `diagram.layout`            |
| `aster_find`          | elements by name substring, kind, stereotype, or "mentions type X"                                                           | `classifiersOf`, `rawMentions`                  |
| `aster_get_selection` | the selected ids with names and kinds, and what is being edited inline                                                       | `selection`                                     |
| `aster_validate`      | the findings the Validation panel shows                                                                                      | `validate(project)`                             |
| `aster_render`        | the diagram or the selection as an SVG string or a PNG image block (MCP `image` content), white or transparent               | `diagramToSvg`, `svgToPng`, `canvasApi.rects()` |
| `aster_changes_since` | the undo labels and touched ids after a version, and whether the user has changed the selection                              | the plugin's change log fed by `aster:changed`  |

### Write

| Tool                        | Does                                                                                                                                                                                            | Commands behind it                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `aster_set_text`            | makes the active diagram match a PlantUML document; one undo step; ids and layout kept for what still exists                                                                                    | `parsePuml` + `planSync` + `batch`                                                                      |
| `aster_add_classifier`      | `{ kind, name, stereotype?, abstract?, attributes?: string[], operations?: string[], literals?: string[], at?, near? }`; member lines in UML text; placed by `freePosition`, or right of `near` | `addClassifier` with `createClassifier` and `memberFromText`                                            |
| `aster_set_members`         | replaces or edits the attribute, operation or literal lines of one classifier (add, remove, rename, reorder by text)                                                                            | `addMember`, `deleteMember`, `setMemberText`, `reorderMember` in a batch                                |
| `aster_connect`             | `{ source, target, kind, name?, stereotype?, sourceEnd?, targetEnd? }` with roles, multiplicities, navigability                                                                                 | `connect`, then `setEnd`, `setRelationshipName`, `setRelationshipStereotype`                            |
| `aster_update`              | rename, stereotype, abstract/leaf/visibility, documentation, relationship kind or flip                                                                                                          | `renameClassifier`, `setClassifierFlags`, `setDocumentation`, `setRelationshipKind`, `flipRelationship` |
| `aster_delete`              | `{ ids, from: 'diagram' \| 'model' }`                                                                                                                                                           | `deleteFromDiagram`, `deleteFromModel`                                                                  |
| `aster_add_note`            | a note, optionally linked to elements                                                                                                                                                           | `addNote`, `linkNote`                                                                                   |
| `aster_move_to_package`     | puts classifiers into a package, creating it when named and missing                                                                                                                             | `addPackage`, `moveToPackage`                                                                           |
| `aster_layout`              | `{ algorithm: 'layered' \| 'orthogonal', direction, only?: ids }`, or `arrange: { id: {x,y} }` for explicit positions                                                                           | the existing `autoLayout` action; `setNodePositions`                                                    |
| `aster_display`             | show/hide visibility, types, multiplicity, signatures; suppress compartments; for the selection or the diagram defaults                                                                         | `setNodeFlags`, `setDiagramDefaults`                                                                    |
| `aster_select`              | selects ids and optionally centres the view on one; `aster_open_diagram` switches tabs                                                                                                          | `selection.set`, `canvasApi.centreOn`, `projectStore.activeDiagramId`                                   |
| `aster_undo` / `aster_redo` | one step, returns the label                                                                                                                                                                     | `projectStore.undo` / `redo`                                                                            |
| `aster_run`                 | escape hatch: `{ label, commands: SerialisedCommand[] }` run as one batch; for anything the tools above do not cover                                                                            | `batch` with `hydrate`                                                                                  |

### Resources and the command catalogue

- `aster://project` (the `.aster` JSON), `aster://diagram/{id}.puml`, `aster://schema/v1.json`.
- `aster://commands`: the catalogue of registered command ids with their argument shapes, so
  `aster_run` is usable without reading the source. First version: a hand-written markdown table
  in `docs/mcp.md` served as the resource; later it can be generated from the `define` calls.

Notifications: MCP has `notifications/resources/updated`, but Claude Code's handling of
subscriptions is thin, so the first version relies on `aster_changes_since` (cheap, explicit) and
returns the current `version` in every response, so Claude notices when the person has edited in
between and can re-read before writing.

## Protocol between the plugin and the tab

```
plugin → tab   { "id": "r1", "method": "get_text", "params": { "dialect": "puml" } }      event aster:req
tab → plugin   { "id": "r1", "ok": true, "version": 412, "result": "@startuml…" }         event aster:res
tab → plugin   { "id": "r2", "ok": false, "error": "Ambiguous name Order: 3 matches…" }
tab → plugin   { "version": 413, "label": "create class Order", "touched": ["…"] }        event aster:changed
tab → plugin   { "project": "Library", "diagram": "Main", "route": "/design/library" }    event aster:hello, on connect
```

- Methods run on the tab's main thread between frames; a tool call times out at 10 s.
- **One tab.** The plugin talks to the most recent tab that sent `aster:hello`. When more than
  one is connected, `aster_status` lists them and the others are read-only until the user clicks
  into one (the tab sends `aster:hello` again on focus). Keeps the first version simple.
- **Who is allowed in.** The MCP endpoint and the socket live on the dev server, which binds to
  localhost. The SDK transport's DNS-rebinding protection is turned on with `localhost` and
  `127.0.0.1` as the allowed hosts. Nothing is exposed when `vite dev --host` is not used.
- **Version check.** Every write may carry `expectVersion`; the tab refuses when the model moved
  on, so Claude re-reads instead of editing a diagram the person changed under it.

## Where the code goes

| Piece                                       | Path                                                            | Notes                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Vite plugin, MCP server, broker, change log | `vite-plugin-aster-mcp.ts` (root) or `scripts/mcp/`             | Node only; imports nothing from `src/lib` that needs a DOM. Wired in `vite.config.ts` under `apply: 'serve'`.                           |
| Tab client                                  | `src/lib/bridge/client.svelte.ts`                               | Mounted by `+layout.svelte` behind `if (import.meta.hot)`. Reads stores, calls `projectStore.run`.                                      |
| Pure handlers                               | `src/lib/bridge/handlers.ts`                                    | `(project, diagramId, args, { place, mint }) => BatchArgs`; no Svelte imports.                                                          |
| Name resolution                             | `src/lib/bridge/resolve.ts`                                     | id or unique name, `Pkg::Name` for packaged classifiers.                                                                                |
| Config                                      | `.mcp.json`, `vite.config.ts` (`strictPort`)                    |                                                                                                                                         |
| Docs                                        | `docs/mcp.md`                                                   | How to connect, the tool list, the command catalogue (also served as `aster://commands`).                                               |
| Decisions                                   | `DECISIONS.md`                                                  | One line: dev-only bridge, outside the milestones; `@modelcontextprotocol/sdk` as a devDependency.                                      |
| Tests                                       | `tests/unit/bridge.test.ts`, `tests/unit/bridge-server.test.ts` | Handlers: run then undo back to equal. Server: `vite.createServer` in a test, a fake tab on the socket, an MCP client against `/__mcp`. |

Rules check against CLAUDE.md: rule 1 holds because every write is a command through
`projectStore.run`; rule 2 holds because neither `types.ts` changes; rule 7 is why this is a
dev-only tool and not a feature, recorded in `DECISIONS.md`; rule 9 is the `cmd.bridge` label
prefix; rule 10 is the one devDependency, which needs your yes before it is added.

## What a session looks like

1. `pnpm dev`, open `http://localhost:5173/design/library`. Open Claude Code in the repo; the
   `aster` server shows as connected.
2. "What's in the diagram?" Claude calls `aster_get_text`, reads the PlantUML, maybe
   `aster_render` to look at it.
3. "Add payment handling: a Payment class, an enum PaymentMethod, Order composes Payment."
   Claude calls `aster_add_classifier` twice and `aster_connect` once, or writes the PlantUML and
   calls `aster_set_text`. Three undo steps (or one) appear in the tab, placed in free space,
   announced in the live region.
4. You drag them where you want them and select Payment. "Make this one abstract and move the
   amount into Money." Claude calls `aster_get_selection`, then `aster_update` and
   `aster_set_members`.
5. "Tidy it." `aster_layout` with layered/DOWN. `aster_render` to check; `aster_validate` to catch
   a duplicate name. ⌘Z undoes any of it, ⌘S saves the `.mdj`, same as before.

## Build plan

Four slices, each green and committed on its own.

1. **Plumbing.** The plugin with `aster_status`, `aster_get_text`, `aster_set_text`; the tab
   client; `.mcp.json`; `strictPort`. This alone is already co-creation through PlantUML. About a
   day.
2. **Read side.** `aster_get_project`, `aster_get_element`, `aster_find`, `aster_get_selection`,
   `aster_validate`, `aster_render` with PNG as image content, `aster_changes_since`.
3. **Write side.** The high-level write tools on top of `handlers.ts`, name resolution,
   `aster_run` plus the `aster://commands` catalogue, version checks on writes.
4. **Polish.** Multi-tab handling, reconnect, `docs/mcp.md`, the integration test, a short
   section in `README.md`.

## Decisions for you

- Streamable HTTP through the Vite dev server (recommended above) or a stdio server?
- OK to add `@modelcontextprotocol/sdk` as a devDependency (it brings `zod`)?
- Undo labels prefixed "Claude: …", or indistinguishable from the user's own steps?
- Should `aster_set_text` be the only write in slice 1, or do you want `aster_add_classifier`
  and `aster_connect` there too?
