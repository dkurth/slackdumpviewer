// Package index builds and opens the viewer's own derived database
// (<archive>/.slackdumpviewer/index.sqlite). It is always rebuildable from
// the archive and is never part of slackdump's data.
package index

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/dkurth/slackdumpviewer/internal/archive"
)

// SchemaVersion changes whenever the index layout or derivation changes,
// forcing a rebuild.
const SchemaVersion = "4"

const schema = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE msg(
  rid INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  id INTEGER NOT NULL,          -- ts in microseconds
  chunk_id INTEGER NOT NULL,    -- archive chunk holding the latest version
  parent_id INTEGER,            -- thread parent id for replies (incl. broadcasts)
  top INTEGER NOT NULL,         -- shown in the channel timeline
  user_id TEXT,
  subtype TEXT,
  flags INTEGER NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mention(rid INTEGER NOT NULL, user_id TEXT NOT NULL);
CREATE TABLE reaction(rid INTEGER NOT NULL, name TEXT NOT NULL, users TEXT);
CREATE TABLE file(
  fid INTEGER PRIMARY KEY,
  file_id TEXT NOT NULL, rid INTEGER NOT NULL, channel_id TEXT NOT NULL, id INTEGER NOT NULL,
  user_id TEXT, name TEXT, title TEXT, filetype TEXT, mimetype TEXT, size INTEGER, mode TEXT
);
CREATE VIRTUAL TABLE msg_fts USING fts5(body, tokenize='porter unicode61 remove_diacritics 2', prefix='2 3');
CREATE VIRTUAL TABLE file_fts USING fts5(name, title, tokenize='porter unicode61 remove_diacritics 2', prefix='2 3');
CREATE TABLE channel_stat(channel_id TEXT PRIMARY KEY, top_count INTEGER, total_count INTEGER, first_id INTEGER, last_id INTEGER);
`

const postIndexes = `
CREATE UNIQUE INDEX msg_ch_id ON msg(channel_id, id);
CREATE INDEX msg_ch_top ON msg(channel_id, top, id);
CREATE INDEX msg_thread ON msg(channel_id, parent_id, id);
CREATE INDEX msg_user ON msg(user_id, id);
CREATE INDEX msg_id ON msg(id);
CREATE INDEX mention_user ON mention(user_id, rid);
CREATE INDEX mention_rid ON mention(rid);
CREATE INDEX reaction_name ON reaction(name, rid);
CREATE INDEX reaction_rid ON reaction(rid);
CREATE INDEX file_fileid ON file(file_id);
CREATE INDEX file_rid ON file(rid);
CREATE INDEX file_ch ON file(channel_id, id);
INSERT INTO channel_stat
  SELECT channel_id, sum(top), count(*), min(id), max(id) FROM msg GROUP BY channel_id;
INSERT INTO msg_fts(msg_fts) VALUES('optimize');
INSERT INTO file_fts(file_fts) VALUES('optimize');
ANALYZE;
`

// Index is an open index database.
type Index struct {
	DB   *sql.DB
	Path string
}

func dsn(path string, params url.Values) string { return archive.SQLiteURI(path, params) }

// Fresh reports whether the index at path exists, is complete and matches the archive.
func Fresh(path string, a *archive.Archive) bool {
	if _, err := os.Stat(path); err != nil {
		return false
	}
	db, err := sql.Open("sqlite", dsn(path, url.Values{"mode": {"ro"}}))
	if err != nil {
		return false
	}
	defer db.Close()
	meta := map[string]string{}
	rows, err := db.Query(`SELECT key, value FROM meta`)
	if err != nil {
		return false
	}
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) == nil {
			meta[k] = v
		}
	}
	rows.Close()
	return meta["schema_version"] == SchemaVersion &&
		meta["complete"] == "1" &&
		meta["source_size"] == strconv.FormatInt(a.DBSize, 10) &&
		meta["source_mtime"] == strconv.FormatInt(a.DBMtime, 10)
}

// Open opens an existing index read-only.
func Open(path string) (*Index, error) {
	db, err := sql.Open("sqlite", dsn(path, url.Values{"mode": {"ro"}}))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(runtime.NumCPU())
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return &Index{DB: db, Path: path}, nil
}

func (ix *Index) Close() error { return ix.DB.Close() }

// Progress is reported during Build.
type Progress struct {
	Phase string `json:"phase"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

type msgKey struct {
	ch string
	id int64
}

type rawRow struct {
	ch       string
	id       int64
	chunk    int64
	parent   sql.NullInt64
	isParent bool
	data     []byte
}

type built struct {
	r         rawRow
	top       bool
	parentID  sql.NullInt64
	user      string
	subtype   string
	flags     int
	replies   int
	body      string
	mentions  []string
	reactions []Reaction
	files     []File
}

// Build creates a complete index at path (writing to path+".tmp" first and
// renaming, so a partial index is never used).
func Build(path string, a *archive.Archive, names Names, progress func(Progress)) error {
	if progress == nil {
		progress = func(Progress) {}
	}
	tmp := path + ".tmp"
	os.Remove(tmp)
	os.Remove(tmp + "-journal")
	db, err := sql.Open("sqlite", dsn(tmp, url.Values{"mode": {"rwc"}}))
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	closeDB := func() { db.Close() }
	defer func() {
		closeDB()
	}()
	for _, p := range []string{"PRAGMA journal_mode=OFF", "PRAGMA synchronous=OFF", "PRAGMA temp_store=MEMORY", "PRAGMA cache_size=-200000"} {
		if _, err := db.Exec(p); err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
	}
	if _, err := db.Exec(schema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}

	// Pass 1: latest chunk per (channel, id). Covered by MESSAGE_DEDUPE_IDX.
	progress(Progress{Phase: "Scanning messages"})
	latest := map[msgKey]int64{}
	rows, err := a.DB.Query(`SELECT CHANNEL_ID, ID, max(CHUNK_ID) FROM MESSAGE GROUP BY CHANNEL_ID, ID`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k msgKey
		var c int64
		if err := rows.Scan(&k.ch, &k.id, &c); err != nil {
			rows.Close()
			return err
		}
		latest[k] = c
	}
	rows.Close()
	total := len(latest)

	// Pass 2: sequential scan, decode latest versions in parallel.
	in := make(chan rawRow, 1024)
	out := make(chan built, 1024)
	var scanErr error
	go func() {
		defer close(in)
		rows, err := a.DB.Query(`SELECT CHANNEL_ID, ID, CHUNK_ID, PARENT_ID, IS_PARENT, DATA FROM MESSAGE`)
		if err != nil {
			scanErr = err
			return
		}
		defer rows.Close()
		for rows.Next() {
			var r rawRow
			var isParent int
			if err := rows.Scan(&r.ch, &r.id, &r.chunk, &r.parent, &isParent, &r.data); err != nil {
				scanErr = err
				return
			}
			if latest[msgKey{r.ch, r.id}] != r.chunk {
				continue
			}
			r.isParent = isParent != 0
			in <- r
		}
		scanErr = rows.Err()
	}()
	var wg sync.WaitGroup
	for i := 0; i < max(2, runtime.NumCPU()-1); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := range in {
				out <- derive(r, names)
			}
		}()
	}
	go func() { wg.Wait(); close(out) }()

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	stmts := map[string]*sql.Stmt{}
	prep := func(q string) *sql.Stmt {
		if s, ok := stmts[q]; ok {
			return s
		}
		s, err := tx.Prepare(q)
		if err != nil {
			panic(err)
		}
		stmts[q] = s
		return s
	}
	const (
		qMsg  = `INSERT INTO msg(rid, channel_id, id, chunk_id, parent_id, top, user_id, subtype, flags, reply_count) VALUES (?,?,?,?,?,?,?,?,?,?)`
		qFTS  = `INSERT INTO msg_fts(rowid, body) VALUES (?,?)`
		qMen  = `INSERT INTO mention(rid, user_id) VALUES (?,?)`
		qReac = `INSERT INTO reaction(rid, name, users) VALUES (?,?,?)`
		qFile = `INSERT INTO file(file_id, rid, channel_id, id, user_id, name, title, filetype, mimetype, size, mode) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
		qFFTS = `INSERT INTO file_fts(rowid, name, title) VALUES (?,?,?)`
	)
	var rid int64
	done := 0
	lastReport := time.Now()
	var writeErr error
	for b := range out {
		if writeErr != nil {
			continue // drain
		}
		rid++
		r := b.r
		if _, err := prep(qMsg).Exec(rid, r.ch, r.id, r.chunk, b.parentID, b2i(b.top), nullStr(b.user), nullStr(b.subtype), b.flags, b.replies); err != nil {
			writeErr = err
			continue
		}
		if b.body != "" {
			if _, err := prep(qFTS).Exec(rid, b.body); err != nil {
				writeErr = err
				continue
			}
		}
		for _, u := range b.mentions {
			prep(qMen).Exec(rid, u)
		}
		for _, re := range b.reactions {
			users, _ := json.Marshal(re.Users)
			prep(qReac).Exec(rid, re.Name, string(users))
		}
		for _, f := range b.files {
			res, err := prep(qFile).Exec(f.ID, rid, r.ch, r.id, nullStr(firstNonEmpty(f.User, b.user)), f.Name, f.Title, f.Filetype, f.Mimetype, f.Size, f.Mode)
			if err == nil && f.Mode != "tombstone" {
				fid, _ := res.LastInsertId()
				prep(qFFTS).Exec(fid, f.Name, f.Title)
			}
		}
		done++
		if time.Since(lastReport) > 200*time.Millisecond {
			lastReport = time.Now()
			progress(Progress{Phase: "Indexing messages", Done: done, Total: total})
		}
	}
	if writeErr != nil {
		tx.Rollback()
		return writeErr
	}
	if scanErr != nil {
		tx.Rollback()
		return scanErr
	}
	for _, s := range stmts {
		s.Close()
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	progress(Progress{Phase: "Finishing index", Done: done, Total: total})
	if _, err := db.Exec(postIndexes); err != nil {
		return fmt.Errorf("post-index: %w", err)
	}
	meta := map[string]string{
		"schema_version": SchemaVersion,
		"source_size":    strconv.FormatInt(a.DBSize, 10),
		"source_mtime":   strconv.FormatInt(a.DBMtime, 10),
		"built_at":       time.Now().UTC().Format(time.RFC3339),
		"messages":       strconv.Itoa(done),
		"complete":       "1",
	}
	for k, v := range meta {
		if _, err := db.Exec(`INSERT INTO meta(key, value) VALUES (?,?)`, k, v); err != nil {
			return err
		}
	}
	db.Close()
	closeDB = func() {}
	os.Remove(path)
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	progress(Progress{Phase: "Done", Done: done, Total: total})
	return nil
}

func derive(r rawRow, names Names) built {
	b := built{r: r}
	var m Msg
	if err := json.Unmarshal(r.data, &m); err != nil {
		b.top = true
		return b
	}
	b.subtype = m.Subtype
	b.user = m.User
	if b.user == "" && m.BotID != "" {
		b.user = m.BotID
	}
	isReply := r.parent.Valid && r.parent.Int64 != r.id
	if isReply {
		b.parentID = r.parent
	}
	b.top = !isReply || m.Subtype == "thread_broadcast"
	f := 0
	live := 0
	for _, fl := range m.Files {
		if fl.Mode != "tombstone" {
			live++
		}
	}
	if live > 0 {
		f |= FlagFile
	}
	if hasLink(&m) {
		f |= FlagLink
	}
	if len(m.Reactions) > 0 {
		f |= FlagReaction
	}
	if len(m.PinnedTo) > 0 {
		f |= FlagPinned
	}
	if isReply {
		f |= FlagReply
	}
	if m.BotID != "" || m.Subtype == "bot_message" {
		f |= FlagBot
	}
	if len(m.Edited) > 0 && string(m.Edited) != "null" {
		f |= FlagEdited
	}
	if !isReply && m.ReplyCount > 0 {
		f |= FlagParent
	}
	if m.Hidden {
		f |= FlagHidden
	}
	b.flags = f
	b.replies = m.ReplyCount
	b.body = SearchBody(&m, names)
	men := map[string]bool{}
	MentionedUsers(m.Text, men)
	for _, a := range m.Attachments {
		MentionedUsers(a.Text, men)
	}
	for u := range men {
		b.mentions = append(b.mentions, u)
	}
	b.reactions = m.Reactions
	b.files = m.Files
	return b
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

var ErrNotBuilt = errors.New("index not built")
