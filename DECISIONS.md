# Decisions log

Small decisions made during the build, for later review. Each has the reason
and how to reverse it. The plan itself is in `../PLAN.md`.

## Data and indexing

1. **Top-level vs. thread messages.** A message appears in the channel timeline if
   it has no `PARENT_ID`, is its own parent (thread starter), or is a
   `thread_broadcast`. The chunk type doesn't matter. *Why:* slackdump stores the
   parent in both history and thread chunks, and some parents exist only in thread
   chunks. *Change in:* `internal/index/index.go` `derive()`.
2. **Latest version wins.** For each `(CHANNEL_ID, ID)`, the row with the highest
   `CHUNK_ID` is used (edits and reactions from later resume runs).
3. **The index is built before browsing works,** not during it. The full build
   takes about 15 s on this archive, so a progress screen on first launch is
   simpler than serving from the raw archive in the meantime. This deviates from
   the plan's "browse while indexing".
4. **Two DB handles instead of ATTACH.** The archive (immutable/read-only) and the
   index (`.slackdumpviewer/index.sqlite`) are opened separately, and lookups join
   in Go. *Why:* it avoids URI/ATTACH quirks with immutable databases on Windows
   paths.
5. **Search body text resolves `<@U…>` to names at index time.** If you later add
   an alias, text search for the new name won't find old mentions. `from:`, `to:`
   and `with:` do follow aliases (they're resolved at query time). Reindex with
   `--reindex` if needed.
6. **Excluded from search results:** join/leave, bot add/remove, shared-channel
   created and tombstone messages (Slack hides these too).
7. **Stemming:** FTS5 `porter unicode61 remove_diacritics 2`, so "deploys" finds
   "deployed" and "cafe" finds "café". Prefix search with `word*`.
8. **Relevance sort** is plain BM25 with newest-first tie-break (Slack also boosts
   recency and your own channels; we don't).
9. **Thread completeness:** about 44k replies are claimed by thread parents but
   only about 23k are in the archive, and 5,066 threads have none. The viewer shows
   "N replies (M archived)" and a note in the thread pane. Fixing it needs another
   slackdump run (see the report).

## Search syntax

10. Supported: words, `"phrases"`, `-exclude`, `prefix*`, `from:`, `in:`,
    `with:`, `to:`, `before:`, `after:`, `on:`, `during:`, `has:link|file|pin|reaction|:emoji:`,
    `is:thread|dm|pinned|edited|bot`. The extras beyond Slack are
    `has:file`, `is:dm|pinned|edited|bot`.
11. Several values of the same filter are OR'ed (`from:@a from:@b` = either),
    and different filters are AND'ed.
12. `before:X` means strictly before day X, and `after:X` strictly after day X
    (Slack's semantics). Dates use your browser's time zone.
13. `with:@x` = DMs/group DMs with x, plus messages in threads x replied to.
14. `has:star` and `is:saved` produce a warning: stars aren't in the archive.

## UI

15. **Sidebar sections:** *Channels* (`is_member` or private), *Direct messages*
    (with messages, most recent first, first 40 then "Show all"), *Other channels*
    (public channels you weren't in, collapsed), *Archived channels* (collapsed).
16. **Copy link copies the Slack permalink** (`https://team.slack.com/archives/…`).
    That URL also works in the viewer: paste it into ⌘K, or use the path
    (`/archives/C…/p…`) in the viewer's address bar. Slack links inside messages
    open in the viewer.
17. **External images** (link previews, bot icons, Block Kit images) are off by
    default to keep the viewer offline. Turn them on in Preferences.
18. **Custom emoji** not in the archive show as a `:name:` pill. If `emojis/` (from
    `slackdump emoji`) exists, those images are used.
19. **Join/leave messages** render compactly, but consecutive joins aren't merged
    into "X and 3 others joined" (Slack does merge them).
20. **Not implemented** (no data, or not meaningful read-only): unreads,
    Activity, Later/saved, the Threads view (⌘⇧T), huddles, composer, reacting.
    Canvases, lists and Quip show placeholder cards.
21. **Profile opens in the right pane** (Slack shows a popover first). Bots have no
    profile.
22. **Message hover toolbar:** view thread, copy link, copy text.

## Launch and runtime

23. **Default port is derived from the archive path** (20000–29999, random if
    taken). *Why:* browser storage is per origin, including the port, so a random
    port would forget preferences, collapsed sections and recent conversations on
    every launch.
24. **App window:** Chrome/Edge/Brave/Chromium with `--app` and its own profile in
    `.slackdumpviewer/browser-profile`. When you close the window, the server
    stops. If the browser hands off to an already-running instance (exits within
    3 s), the server keeps running until Ctrl+C.
25. **`SLACKDUMPVIEWER_NO_OPEN=1`** forces `--no-open`. Tests and scripts use it so
    nothing ever opens on screen.
26. **Writes:** the only API write is `PUT /api/aliases/{id}`, which requires an
    `X-Requested-With` header (CSRF guard) and only writes `aliases.json`. The
    server checks the `Host` header (DNS-rebinding guard).
27. **Uploaded HTML/SVG/etc.** are served as downloads (or as plain text with
    `?raw=1`), never rendered on the viewer's origin. Files get a sandbox CSP.
28. **Thumbnails:** generated on demand into `.slackdumpviewer/thumbs/` with EXIF
    orientation applied. Animated GIFs and small images are served as-is.
29. **Built frontend is committed** (`internal/server/dist`), so `go build` /
    `go install` work without Node.
30. **Playwright is pinned to 1.64.1** because that's the version whose headless
    Chromium (build 1248) is already installed on this Mac.
31. **Telling it apart from Slack:** the top bar is deep teal (`--topbar-bg`:
    `#0e4a4f` light, `#113a3e` dark), the complement of Slack's aubergine and
    unlike any Slack theme. It shows a "SlackDumpViewer" label, and window titles
    end in "— SlackDumpViewer".
32. **Gear menu** (top right): About this archive, Aliases, Preferences, Keyboard
    shortcuts. The Aliases page is the former "Unknown users" page, now at
    `/aliases` (`/unknown-users` still works). It gained a Rejected tab.
33. **About page stats** are computed once per launch from the index (the archive
    can't change while the viewer runs). Message counts exclude hidden system
    messages. Thread broadcasts count as both channel messages and replies.
    "Exported by" is `WORKSPACE.USER_ID`. Run times come from slackdump's
    `SESSION` table (UTC) and are shown in local time.
