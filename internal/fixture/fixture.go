// Package fixture generates a small synthetic slackdump archive for tests.
// It mirrors slackdump's schema and quirks: WAL mode with no -wal/-shm left
// behind, entities repeated across chunks (latest chunk wins), thread
// replies only in thread chunks, broadcasts in both.
package fixture

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"

	"github.com/dkurth/slackdumpviewer/internal/archive"
)

const schema = `
CREATE TABLE SESSION (ID INTEGER PRIMARY KEY, CREATED_AT TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UPDATED_AT TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PAR_SESSION_ID INTEGER, FROM_TS TIMESTAMP, TO_TS TIMESTAMP, FINISHED SMALLINT NOT NULL DEFAULT FALSE, FILES_ENABLED SMALLINT NOT NULL DEFAULT FALSE, AVATARS_ENABLED SMALLINT NOT NULL DEFAULT FALSE, MODE TEXT NOT NULL, ARGS TEXT);
CREATE TABLE CHUNK (ID INTEGER PRIMARY KEY, CREATED_AT TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIX_TS INTEGER NOT NULL, SESSION_ID INTEGER NOT NULL, TYPE_ID SMALLINT NOT NULL, NUM_REC INTEGER NOT NULL DEFAULT 0, FINAL SMALLINT NOT NULL DEFAULT FALSE, CHANNEL_ID TEXT, SEARCH_QUERY TEXT, THREAD_ONLY BOOLEAN);
CREATE TABLE MESSAGE (ID INTEGER NOT NULL, CHUNK_ID INTEGER NOT NULL, LOAD_DTTM TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, CHANNEL_ID TEXT NOT NULL, TS TEXT NOT NULL, PARENT_ID INTEGER, THREAD_TS TEXT, LATEST_REPLY TEXT, IS_PARENT SMALLINT NOT NULL DEFAULT FALSE, IDX INTEGER NOT NULL, NUM_FILES INTEGER NOT NULL DEFAULT 0, TXT TEXT, DATA BLOB NOT NULL, PRIMARY KEY (ID, CHUNK_ID));
CREATE INDEX MESSAGE_DEDUPE_IDX ON MESSAGE (CHANNEL_ID, ID, CHUNK_ID);
CREATE TABLE CHANNEL (ID TEXT NOT NULL, CHUNK_ID INTEGER NOT NULL, LOAD_DTTM TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, NAME TEXT, IDX INTEGER NOT NULL, DATA BLOB NOT NULL, PRIMARY KEY (ID, CHUNK_ID));
CREATE TABLE FILE (ID TEXT NOT NULL, CHUNK_ID INTEGER NOT NULL, LOAD_DTTM TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, CHANNEL_ID TEXT NOT NULL, MESSAGE_ID INTEGER, THREAD_ID INTEGER, IDX INTEGER NOT NULL, MODE TEXT NOT NULL, FILENAME TEXT, URL TEXT, DATA BLOB NOT NULL, SIZE INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ID, CHUNK_ID));
CREATE TABLE WORKSPACE (ID INTEGER PRIMARY KEY, CHUNK_ID INTEGER NOT NULL, LOAD_DTTM TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, TEAM TEXT NOT NULL, USERNAME TEXT, TEAM_ID TEXT NOT NULL, USER_ID TEXT NOT NULL, ENTERPRISE_ID TEXT, URL TEXT NOT NULL, DATA BLOB NOT NULL);
CREATE TABLE S_USER (ID TEXT NOT NULL, CHUNK_ID INTEGER NOT NULL, LOAD_DTTM TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, IDX INTEGER NOT NULL, USERNAME TEXT NOT NULL, DATA BLOB NOT NULL, PRIMARY KEY (ID, CHUNK_ID));
CREATE TABLE CHANNEL_USER (CHANNEL_ID TEXT NOT NULL, USER_ID TEXT NOT NULL, CHUNK_ID INTEGER NOT NULL, LOAD_DTTM TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, IDX INTEGER NOT NULL, PRIMARY KEY (CHANNEL_ID, USER_ID, CHUNK_ID));
`

// Chunk types (slackdump chunk.ChunkType)
const (
	tMessages     = 0
	tThread       = 1
	tUsers        = 3
	tChannels     = 4
	tWorkspace    = 6
	tChannelUsers = 7
)

// Base timestamp: 2024-03-04 15:00:00 UTC
const BaseSec = 1709564400

// TS returns the ts string for message n (one minute apart).
func TS(n int) string { return fmt.Sprintf("%d.%06d", BaseSec+int64(n)*60, n) }

// ID returns the integer id for message n.
func ID(n int) int64 { return (BaseSec+int64(n)*60)*1_000_000 + int64(n) }

const (
	Me      = "U00ME"
	Alice   = "U0ALICE"
	Bob     = "U0BOB"
	Carol   = "U0CAROL"
	OldBob  = "U0OLDBOB" // pre-merge account, no profile
	General = "C0GENERAL"
	Private = "G0PRIVATE"
	Archive = "C0ARCHIVED"
	DMAlice = "D0ALICE"
	DMOld   = "D0OLDBOB"
	Group   = "G0MPIM"
)

// GeneralCount is the number of top-level messages in #general.
const GeneralCount = 250

// Build writes a fixture archive into dir and returns the archive path.
func Build(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dbPath := filepath.Join(dir, "slackdump.sqlite")
	db, err := sql.Open("sqlite", archive.SQLiteURI(dbPath, url.Values{"mode": {"rwc"}}))
	if err != nil {
		return "", err
	}
	db.SetMaxOpenConns(1)
	defer db.Close()
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return "", err
	}
	if _, err := db.Exec(schema); err != nil {
		return "", err
	}
	b := &builder{db: db}
	b.exec(`INSERT INTO SESSION(ID, MODE, FINISHED, FILES_ENABLED) VALUES (1,'archive',1,1),(2,'resume',1,1)`)

	// Workspace
	c := b.chunk(1, tWorkspace, "")
	b.exec(`INSERT INTO WORKSPACE(ID, CHUNK_ID, TEAM, USERNAME, TEAM_ID, USER_ID, URL, DATA) VALUES (1,?,?,?,?,?,?,?)`,
		c, "Example Co", "me", "T0TEAM", Me, "https://example.slack.com/", js(map[string]any{"team": "Example Co"}))

	// Users: two chunks; Alice's later version has a new title.
	users := []map[string]any{
		user(Me, "me", "Pat Example", "Pat", "Engineer"),
		user(Alice, "alice", "Alice Anders", "alice", "Designer"),
		user(Bob, "bob", "Bob Brown", "", "PM"),
		user(Carol, "carol", "Carol Chen", "carolc", "QA"),
	}
	c = b.chunk(1, tUsers, "")
	for i, u := range users {
		b.exec(`INSERT INTO S_USER(ID, CHUNK_ID, IDX, USERNAME, DATA) VALUES (?,?,?,?,?)`, u["id"], c, i, u["name"], js(u))
	}
	c = b.chunk(2, tUsers, "")
	a2 := user(Alice, "alice", "Alice Anders", "alice", "Design Lead")
	b.exec(`INSERT INTO S_USER(ID, CHUNK_ID, IDX, USERNAME, DATA) VALUES (?,?,?,?,?)`, Alice, c, 0, "alice", js(a2))

	// Channels
	c = b.chunk(1, tChannels, "")
	chans := []map[string]any{
		{"id": General, "name": "general", "is_channel": true, "is_general": true, "created": BaseSec - 86400, "topic": map[string]any{"value": "Company-wide"}, "purpose": map[string]any{"value": "Everything"}},
		{"id": Private, "name": "secret-project", "is_channel": true, "is_private": true, "created": BaseSec},
		{"id": Archive, "name": "old-stuff", "is_channel": true, "is_archived": true, "created": BaseSec},
		{"id": DMAlice, "is_im": true, "user": Alice, "created": BaseSec},
		{"id": DMOld, "is_im": true, "user": OldBob, "created": BaseSec},
		{"id": Group, "name": "mpdm-me--alice--bob-1", "is_mpim": true, "created": BaseSec},
	}
	for i, ch := range chans {
		name, _ := ch["name"].(string)
		b.exec(`INSERT INTO CHANNEL(ID, CHUNK_ID, NAME, IDX, DATA) VALUES (?,?,?,?,?)`, ch["id"], c, name, i, js(ch))
	}
	members := map[string][]string{
		General: {Me, Alice, Bob, Carol}, Private: {Me, Alice}, Archive: {Me}, DMAlice: {Me, Alice}, DMOld: {Me, OldBob}, Group: {Me, Alice, Bob},
	}
	for ch, ms := range members {
		c = b.chunk(1, tChannelUsers, ch)
		for i, u := range ms {
			b.exec(`INSERT INTO CHANNEL_USER(CHANNEL_ID, USER_ID, CHUNK_ID, IDX) VALUES (?,?,?,?)`, ch, u, c, i)
		}
	}

	// #general: GeneralCount messages across two history chunks; message 100
	// is a thread parent; 101.. replies in a thread chunk; one broadcast.
	authors := []string{Me, Alice, Bob, Carol, OldBob}
	c1 := b.chunk(1, tMessages, General)
	for n := 0; n < GeneralCount; n++ {
		m := msg(n, authors[n%len(authors)], fmt.Sprintf("General message number %d about the roadmap", n))
		switch n {
		case 5:
			m["text"] = "Hey <@" + Alice + ">, check <https://example.com/docs|the docs> :tada:"
			m["reactions"] = []any{map[string]any{"name": "tada", "count": 2, "users": []string{Me, Bob}}}
		case 6:
			m["text"] = "Here is the mockup"
			m["files"] = []any{fileObj("F0IMAGE1", "mockup.png", "image/png", "png", "hosted")}
		case 7:
			m["files"] = []any{map[string]any{"id": "F0GONE", "mode": "tombstone", "name": "deleted"}}
		case 8:
			m["pinned_to"] = []string{General}
			m["text"] = "Pinned: release checklist"
		case 9:
			m["subtype"] = "bot_message"
			m["bot_id"] = "B0BOT"
			m["username"] = "Deploy Bot"
			delete(m, "user")
			m["attachments"] = []any{map[string]any{"color": "36a64f", "title": "Deploy finished", "text": "Build *42* deployed to production", "fields": []any{map[string]any{"title": "Env", "value": "prod", "short": true}}}}
		case 10:
			m["subtype"] = "channel_join"
			m["text"] = "<@" + Carol + "> has joined the channel"
			m["user"] = Carol
		case 100:
			m["text"] = "Thread starter: should we ship Friday?"
			m["thread_ts"] = TS(100)
			m["reply_count"] = 4 // only 3 archived + 1 broadcast
			m["reply_users"] = []string{Alice, Bob}
			m["latest_reply"] = TS(104)
		}
		parent := any(nil)
		isParent := 0
		if n == 100 {
			parent, isParent = ID(100), 1
		}
		b.message(c1, General, n, m, parent, isParent)
	}
	// Later resume chunk re-inserts message 5 with an edit (latest wins).
	c2 := b.chunk(2, tMessages, General)
	m5 := msg(5, Me, "Hey <@"+Alice+">, check <https://example.com/docs|the docs> :tada: (edited)")
	m5["edited"] = map[string]any{"user": Me, "ts": TS(5)}
	m5["reactions"] = []any{map[string]any{"name": "tada", "count": 2, "users": []string{Me, Bob}}, map[string]any{"name": "+1", "count": 1, "users": []string{Carol}}}
	b.message(c2, General, 5, m5, nil, 0)
	// Broadcast reply (appears in history and thread).
	bc := msg(250, Alice, "Replying in thread and channel: yes, ship it")
	bc["subtype"] = "thread_broadcast"
	bc["thread_ts"] = TS(100)
	b.message(c2, General, 250, bc, ID(100), 0)

	ct := b.chunk(2, tThread, General)
	pm := msg(100, Me, "Thread starter: should we ship Friday?")
	pm["thread_ts"], pm["reply_count"], pm["reply_users"] = TS(100), 4, []string{Alice, Bob}
	b.message(ct, General, 100, pm, ID(100), 1)
	for i, n := range []int{251, 252, 253} {
		r := msg(n, []string{Alice, Bob, Alice}[i], fmt.Sprintf("Reply %d: Friday deploys are risky", i+1))
		r["thread_ts"] = TS(100)
		b.message(ct, General, n, r, ID(100), 0)
	}

	// DM with Alice; DM with old Bob account ("Hey Bob" for alias suggestion).
	cd := b.chunk(1, tMessages, DMAlice)
	b.message(cd, DMAlice, 300, msg(300, Me, "Hi Alice, lunch tomorrow?"), nil, 0)
	b.message(cd, DMAlice, 301, msg(301, Alice, "Sure! The usual place"), nil, 0)
	co := b.chunk(1, tMessages, DMOld)
	b.message(co, DMOld, 310, msg(310, Me, "Hey Bob, can you review the PR?"), nil, 0)
	b.message(co, DMOld, 311, msg(311, OldBob, "On it"), nil, 0)
	b.message(co, DMOld, 312, msg(312, Me, "Thanks Bob!"), nil, 0)
	cp := b.chunk(1, tMessages, Private)
	b.message(cp, Private, 320, msg(320, Alice, "Secret: the codename is Javelina"), nil, 0)
	cg := b.chunk(1, tMessages, Group)
	b.message(cg, Group, 330, msg(330, Bob, "Group chat hello"), nil, 0)
	ca := b.chunk(1, tMessages, Archive)
	b.message(ca, Archive, 340, msg(340, Me, "Old archived discussion about café naïve résumé"), nil, 0)

	if b.err != nil {
		return "", b.err
	}
	if err := db.Close(); err != nil {
		return "", err
	}
	// Uploads and avatars.
	pngData := tinyPNG(40, 30)
	if err := writeFile(filepath.Join(dir, "__uploads", "F0IMAGE1", "mockup.png"), pngData); err != nil {
		return "", err
	}
	if err := writeFile(filepath.Join(dir, "__avatars", Alice, "123_original.png"), tinyPNG(64, 64)); err != nil {
		return "", err
	}
	os.Remove(dbPath + "-wal")
	os.Remove(dbPath + "-shm")
	return dir, nil
}

type builder struct {
	db    *sql.DB
	lastChunk int64
	err   error
}

func (b *builder) exec(q string, args ...any) {
	if b.err != nil {
		return
	}
	if _, err := b.db.Exec(q, args...); err != nil {
		b.err = fmt.Errorf("%s: %w", q, err)
	}
}

func (b *builder) chunk(session int, typ int, ch string) int64 {
	b.lastChunk++
	b.exec(`INSERT INTO CHUNK(ID, UNIX_TS, SESSION_ID, TYPE_ID, CHANNEL_ID, FINAL) VALUES (?,?,?,?,?,1)`, b.lastChunk, BaseSec, session, typ, nullIf(ch))
	return b.lastChunk
}

func (b *builder) message(chunk int64, ch string, n int, m map[string]any, parent any, isParent int) {
	threadTS, _ := m["thread_ts"].(string)
	files := 0
	if fs, ok := m["files"].([]any); ok {
		files = len(fs)
	}
	text, _ := m["text"].(string)
	b.exec(`INSERT INTO MESSAGE(ID, CHUNK_ID, CHANNEL_ID, TS, PARENT_ID, THREAD_TS, IS_PARENT, IDX, NUM_FILES, TXT, DATA) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		ID(n), chunk, ch, TS(n), parent, nullIf(threadTS), isParent, n, files, text, js(m))
}

func nullIf(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func msg(n int, user, text string) map[string]any {
	return map[string]any{"type": "message", "user": user, "text": text, "ts": TS(n)}
}

func user(id, name, real, display, title string) map[string]any {
	return map[string]any{"id": id, "team_id": "T0TEAM", "name": name, "real_name": real, "color": "4bbe2e",
		"profile": map[string]any{"real_name": real, "display_name": display, "title": title}}
}

func fileObj(id, name, mime, ft, mode string) map[string]any {
	return map[string]any{"id": id, "name": name, "title": name, "mimetype": mime, "filetype": ft, "mode": mode, "size": 1234,
		"original_w": 40, "original_h": 30, "url_private": "https://files.slack.com/files-pri/T-" + id + "/" + name}
}

func js(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func tinyPNG(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 6), uint8(y * 8), 200, 255})
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

func writeFile(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}
