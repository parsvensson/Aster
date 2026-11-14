---
name: uml-modelling
description: Co-edit a UML class model with the user in Aster, a browser-based modeller for StarUML .mdj and .aster files kept in the repository. Use when the user asks to look at, propose changes to, create or edit a UML model, class diagram or view in a .mdj or .aster file ("suggest changes to docs/model.mdj, view alpha"), or mentions Aster or StarUML models.
---

# Co-editing UML models with Aster

Aster shows the model in a browser tab. You edit it through the `aster_*` tools; the user edits
the same diagram by hand in the tab. The model file in the repository is the single source of
truth: every change in the tab, yours or the user's, is written to the file within a second, and
a change to the file from outside (git checkout, pull, stash) reloads the tab.

## Start

1. Read whatever context the user pointed at (source files, docs) before touching the model.
2. Call `aster_open` with the model file's path relative to the repository and, when the user
   named a view, `diagram`. A file that does not exist yet becomes a new project with one empty
   diagram of that name.
3. When the answer says `connected: false`, open its `url` in the browser: the built-in browser
   pane when the session has one (navigate there), otherwise give the user the URL to open
   themselves. The tab loads the file as it connects. Then call `aster_status`.
4. When the answer has a `note` that the diagram was not found, ask whether to create it, then
   `aster_add_diagram` with `open: true`.

## Work

- Look first: `aster_get_text` gives the diagram as PlantUML, `aster_render` a picture,
  `aster_get_selection` what the user has selected ("this one").
- Propose before large changes. For a request like "suggest changes", describe the changes in
  chat, and apply them when the user agrees, unless they asked you to go ahead.
- Small edits: the dedicated tools (`aster_add_classifier`, `aster_set_members`, `aster_connect`,
  `aster_update`, `aster_delete`, `aster_move_to_package`, `aster_add_note`).
- Larger edits: read with `aster_get_text`, edit the PlantUML, write with `aster_set_text` and
  `expectVersion`, so a change the user made in between is not overwritten.
- The user edits too. Before a write that follows a pause, call `aster_changes_since` or
  `aster_status` and read again when the version moved.
- Layout is the user's as much as the model: do not run `aster_layout` over a diagram the user
  has arranged unless asked; place new elements near their neighbours instead.
- Every write is one undo step in the tab. `aster_undo` takes back your last step; prefer it over
  deleting what you just made.
- After a round of changes, `aster_validate` and `aster_render` to check the result, and
  `aster_select` with `centre: true` to point the user at what changed.

## Git

The file on disk is always current, so git works as usual: `git diff --stat` to see that a
change landed, commit when the user asks. The first save of a file last written by StarUML
reorders some keys (a one-time diff of a few percent of the file); after that only real changes
show. Do not edit the model file with text tools while it is open: use the `aster_*` tools, or
the tab reloads and the undo history is lost.
