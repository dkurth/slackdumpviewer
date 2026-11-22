# slackdumpviewer

A Slack-like, read-only viewer for archives made with
[`slackdump archive`](https://github.com/rusq/slackdump). It works on macOS and
Windows.

```sh
slackdumpviewer ~/code/slack-export/slackdump_20261121_104152
```

The command opens the archive in its own app window (Chrome, Edge, Brave or
Chromium in `--app` mode). Closing the window stops the viewer.

## Making an archive

You need [slackdump](https://github.com/rusq/slackdump) to download your
workspace first.

**Mac**

```sh
brew install slackdump
slackdump workspace new        # sign in to Slack in the browser that opens
caffeinate -i slackdump archive
```

`caffeinate -i` keeps the Mac awake for the hours a big archive can take. If you
forgot it, attach it to the running job: `caffeinate -i -w $(pgrep -x slackdump)`.

**Windows**

Download the Windows zip from the
[slackdump releases page](https://github.com/rusq/slackdump/releases), unzip
`slackdump.exe` somewhere on your `PATH`, then in PowerShell:

```powershell
slackdump workspace new        # sign in to Slack in the browser that opens
slackdump archive
```

Windows has no `caffeinate`, so set **Settings → System → Power → Sleep** to
*Never* while it runs.

**Both**

The archive lands in a folder like `slackdump_20261121_104152`. Later:

```sh
slackdump resume ./slackdump_…                                  # add newer messages
slackdump resume -refresh -threads -dedupe ./slackdump_…        # continue an interrupted archive
slackdump resume -avatars -only-new-users=false -dedupe ./slackdump_…   # avatars → __avatars/
slackdump emoji -full -o ./slackdump_…                          # custom emoji → emojis/
```

If an archive was interrupted, some threads may be missing replies. The viewer
marks them ("4 replies (2 archived)").

## What you get

- **Slack's layout:** a sidebar with channels, DMs, other and archived channels;
  a message list grouped by author with day dividers; a thread pane; profiles;
  channel details (About, Members, Pins, Files); channel, DM and people browsers;
  light and dark themes.
- **Conversations open at the newest message,** and older messages load as you
  scroll up. Click a day divider (or the floating date) to **Jump to…** the most
  recent message, last week, last month, last year, the very beginning, or a
  specific date.
- **Threads open at the latest reply,** with a "Jump to the beginning of the
  thread" link. Replies missing from the archive are called out ("4 replies (2
  archived)").
- **Message rendering:** rich text, Slack markdown, mentions, emoji (Unicode, plus
  custom emoji if you downloaded them), reactions with who reacted, inline images
  with a lightbox, video and audio, code snippets with syntax highlighting, files,
  bot attachments, Block Kit, link previews, pins and edits.
- **Slack permalinks work.** Links between messages open in the viewer, and you
  can paste a `https://<team>.slack.com/archives/…` link into ⌘K. "Copy link"
  copies the real Slack permalink.
- **Unknown users:** user IDs with no profile in the archive (for example, old
  accounts from a merged workspace) get evidence-based alias suggestions that you
  confirm on the Unknown users page.

## Search

This is Slack's syntax, typed in the top bar (⌘G). Filter buttons on the results
page edit the same query text.

| Syntax | Meaning |
|---|---|
| `word other` | both words (stemmed: *deploy* finds *deployed*; accents ignored) |
| `"exact phrase"` | phrase |
| `-word`, `-"phrase"` | exclude |
| `rep*` | prefix |
| `from:@user`, `from:me` | author (includes confirmed alias accounts) |
| `in:#channel`, `in:@user` | a channel, or your DM with someone |
| `with:@user` | DMs and threads with that person |
| `to:@user`, `to:me` | messages mentioning them, or DMs to them |
| `before:` `after:` `on:` `during:` | `2024-03-05`, `3/5/2024`, `2024-03`, `2023`, `today`, `yesterday`, `week`, `month`, `year`, `march`, `march-2024`, `monday` |
| `has:link` `has:file` `has:pin` `has:reaction` `has::emoji:` | flags |
| `is:thread` `is:dm` `is:pinned` `is:edited` `is:bot` | flags |

Several values of the same filter mean "either" (`from:@a from:@b`). The result
tabs are Messages, Files, Channels and People. Sort by Most relevant, Newest or
Oldest.

## Keyboard shortcuts

On Windows, use Ctrl instead of ⌘. ⌘/ shows this list in the app.

| | |
|---|---|
| ⌘K | Jump to a conversation (quick switcher; also accepts Slack links) |
| ⌘G / ⌘F | Search / search in the current conversation |
| ⌥↑ / ⌥↓ | Previous / next conversation in the sidebar |
| ⌘[ / ⌘] | Back / forward |
| ⌘⇧L / ⌘⇧K / ⌘⇧E | Browse channels / DMs / people |
| ⌘⇧I | Conversation details |
| ⌘⇧D / ⌘. | Toggle sidebar / right pane |
| F6, ⇧F6 | Move focus between sidebar, messages and thread |
| ↑ ↓ | Move between messages; **Enter** or **T** opens the thread; **L** copies the link |
| Home / End | Oldest / most recent messages |
| Esc | Close the pane, dialog or menu |

In `--tab` mode (a normal browser tab), the browser keeps some keys (⌘T, ⌘N,
⌘W, and F6 on Windows). The app window doesn't have that problem.

## Command line

```
slackdumpviewer [flags] <archive-dir | slackdump.sqlite>
  --tab            open in a normal browser tab instead of an app window
  --no-open        don't open anything; just print the URL
  --port N         port (default: a stable port derived from the archive path)
  --reindex        rebuild the search index
  --cache-dir DIR  where the viewer keeps its files

slackdumpviewer aliases suggest <archive-dir>   # refresh alias suggestions
```

## The archive is never modified

`slackdump.sqlite` is opened with `immutable=1`, which creates no files and takes
no locks. If a `-wal` file shows slackdump is running, it's opened read-only
instead, with a warning banner. `__uploads/`, `__avatars/` and `emojis/` are only
read.

Everything the viewer creates goes in **`<archive>/.slackdumpviewer/`**:

| File | |
|---|---|
| `index.sqlite` | search index (rebuilt automatically when the archive changes; about 15 s for 500k messages) |
| `aliases.json` | **your** alias decisions. Edit by hand or on the Unknown users page; keep it |
| `thumbs/` | image and avatar thumbnails |
| `browser-profile/` | the app window's browser profile |

Deleting the folder is safe (keep `aliases.json` if you've reviewed aliases). If
the archive folder isn't writable, the viewer uses your OS cache folder instead.

## Building

You need Go 1.26+ and Node 24+.

```sh
make build        # → ./slackdumpviewer   (GOOS=windows make go → slackdumpviewer.exe)
make test         # go vet, Go tests, TypeScript check
make e2e          # headless Playwright tests against a synthetic archive
make release      # dist/: darwin arm64/amd64, windows amd64/arm64
```

The built frontend (`internal/server/dist`) is committed, so `go build` and
`go install ./cmd/slackdumpviewer` work without Node.

For frontend development, run the server on port 8765
(`slackdumpviewer --no-open --port 8765 <archive>`), then `cd web && npm run dev`.

Tests never open windows. The e2e suite runs the binary with `--no-open`
against `internal/fixture` (a generated archive with slackdump's schema and
quirks) in headless Chromium. CI runs everything on macOS and Windows.

The design decisions are logged in [DECISIONS.md](DECISIONS.md).
