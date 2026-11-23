# SlackDumpViewer

A Slack-like, read-only viewer for archives made with
[`slackdump archive`](https://github.com/rusq/slackdump). It works on macOS and
Windows.

```sh
slackdumpviewer ~/code/slack-export/slackdump_20261121_104152
```

The command opens the archive in its own app window (Chrome, Edge, Brave or
Chromium in `--app` mode). Closing the window stops the viewer.

## Installing

SlackDumpViewer is a single program file with nothing else to install. It
needs a Chromium-based browser (Chrome, Edge, Brave or Chromium) for its app
window. Windows already has Edge. Without one, the viewer opens in your default
browser as a normal tab.

Download the file for your computer from the
[Releases page](https://github.com/dkurth/slackdumpviewer/releases/latest):

| Computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `slackdumpviewer-darwin-arm64` |
| Mac with an Intel processor | `slackdumpviewer-darwin-amd64` |
| Windows PC (most PCs) | `slackdumpviewer-windows-amd64.exe` |
| Windows on ARM (e.g. Snapdragon laptops) | `slackdumpviewer-windows-arm64.exe` |

On a Mac, **Apple menu → About This Mac** shows *Chip: Apple M…* or *Processor: Intel*.
On Windows, **Settings → System → About → System type** says *x64-based* or
*ARM-based*.

### Mac

In Terminal (use `amd64` instead of `arm64` on an Intel Mac):

```sh
mkdir -p ~/bin
curl -L -o ~/bin/slackdumpviewer \
  https://github.com/dkurth/slackdumpviewer/releases/latest/download/slackdumpviewer-darwin-arm64
chmod +x ~/bin/slackdumpviewer
```

If `~/bin` isn't on your `PATH` yet, add it and open a new Terminal window:

```sh
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```

Check that it works with `slackdumpviewer --version`.

The program isn't signed by Apple. Downloading it with `curl` as above avoids
any warning. If you downloaded it in a browser instead and macOS says it
"cannot be opened because the developer cannot be verified", remove the
download flag:

```sh
xattr -d com.apple.quarantine ~/bin/slackdumpviewer
```

### Windows

1. Make a folder for it, e.g. `C:\Tools`.
2. Download `slackdumpviewer-windows-amd64.exe` (or `-arm64.exe`) into it and
   rename it to `slackdumpviewer.exe`.
3. Add the folder to your `PATH`: press Start, type **environment variables**,
   open *Edit environment variables for your account*, select **Path** →
   **Edit** → **New**, type `C:\Tools`, then **OK**.
4. Open a **new** PowerShell window and check it works:

   ```powershell
   slackdumpviewer --version
   ```

Or do the same in PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\Tools | Out-Null
Invoke-WebRequest -OutFile C:\Tools\slackdumpviewer.exe `
  https://github.com/dkurth/slackdumpviewer/releases/latest/download/slackdumpviewer-windows-amd64.exe
Unblock-File C:\Tools\slackdumpviewer.exe
[Environment]::SetEnvironmentVariable('Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ';C:\Tools', 'User')
```

The program isn't signed. If Windows SmartScreen shows "Windows protected your
PC", click **More info → Run anyway**. Running `Unblock-File` on the file first
prevents the warning.

It's a command-line program, so start it from PowerShell or Command Prompt
rather than by double-clicking:

```powershell
slackdumpviewer D:\slack\slackdump_20261121_104152
```

### From source

With Go 1.26 or later, on either system:

```sh
go install github.com/dkurth/slackdumpviewer/cmd/slackdumpviewer@latest
```

This puts `slackdumpviewer` in `~/go/bin` (`%USERPROFILE%\go\bin` on Windows).
No Node is needed, because the built frontend is committed. See
[Building](#building) for the rest.

### Updating and uninstalling

To update, download the new file over the old one. To uninstall, delete it.
The viewer's own data lives in each archive's `.slackdumpviewer/` folder (see
[below](#the-archive-is-never-modified)).

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
- **The gear menu** (top right) has **About this archive** (where it is, when and
  how it was made, and counts of messages, threads, files and people, by year and
  top conversations) and **Aliases**.
- **Aliases:** user IDs with no profile in the archive (for example, old
  accounts from a merged workspace) get evidence-based alias suggestions that you
  confirm, reject or edit on the Aliases page.
- **It doesn't pass for Slack:** a teal top bar with a SlackDumpViewer label,
  and window titles that end in "— SlackDumpViewer".

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
