package server

import (
	"database/sql"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dkurth/slackdumpviewer/internal/index"
)

// GET /api/about: where the archive is, how it was made, and what's in it.
// Archive and index are immutable while the server runs, so the stats are
// computed once (the aliases summary is recomputed per request).

type aboutSession struct {
	ID       int    `json:"id"`
	Created  string `json:"created"` // RFC 3339, UTC
	Updated  string `json:"updated"`
	Mode     string `json:"mode"`
	Finished bool   `json:"finished"`
	Files    bool   `json:"files"`
	Avatars  bool   `json:"avatars"`
	Command  string `json:"command"`
}

type aboutCount struct {
	ID    string `json:"id"`
	Count int    `json:"count"`
}

type aboutYear struct {
	Year  string `json:"year"`
	Count int    `json:"count"`
}

type aboutStats struct {
	ArchiveDir string         `json:"archive_dir"`
	DBPath     string         `json:"db_path"`
	DBSize     int64          `json:"db_size"`
	DBModified string         `json:"db_modified"`
	InUse      bool           `json:"in_use"`
	CacheDir   string         `json:"cache_dir"`
	IndexSize  int64          `json:"index_size"`
	Sessions   []aboutSession `json:"sessions"`

	Messages  int    `json:"messages"`
	TopLevel  int    `json:"top_level"`
	Replies   int    `json:"replies"`
	Threads   int    `json:"threads"`
	Claimed   int    `json:"claimed_replies"` // replies the parents say exist
	Edited    int    `json:"edited"`
	Pinned    int    `json:"pinned"`
	WithFiles int    `json:"with_files"`
	WithLinks int    `json:"with_links"`
	Bot       int    `json:"bot"`
	Reactions int    `json:"reactions"`
	FirstTS   string `json:"first_ts,omitempty"`
	LastTS    string `json:"last_ts,omitempty"`

	FileRefs      int   `json:"file_refs"`
	FilesDistinct int   `json:"files"`
	FilesBytes    int64 `json:"files_bytes"` // sizes Slack reported
	LocalFiles    int   `json:"local_files"`
	LocalBytes    int64 `json:"local_bytes"`

	Conversations map[string]int `json:"conversations"` // by kind, plus "archived" and "with_messages"
	Users         map[string]int `json:"users"`         // total, active, deactivated, bots, external
	Unknown       int            `json:"unknown_users"`
	Avatars       int            `json:"avatars"`
	CustomEmoji   int            `json:"custom_emoji"`

	ByYear      []aboutYear  `json:"by_year"`
	TopChannels []aboutCount `json:"top_channels"`
	TopPosters  []aboutCount `json:"top_posters"`
}

type aboutCache struct {
	once  sync.Once
	stats *aboutStats
	err   error
}

func (s *Server) handleAbout(w http.ResponseWriter, r *http.Request) {
	s.about.once.Do(func() { s.about.stats, s.about.err = s.computeAbout() })
	if s.about.err != nil {
		writeErr(w, 500, s.about.err.Error())
		return
	}
	counts := map[string]int{}
	for _, e := range s.aliases.Snapshot() {
		counts[e.Status]++
	}
	writeJSON(w, 200, map[string]any{
		"stats":        s.about.stats,
		"workspace":    s.ws,
		"me":           s.dir.Me(),
		"aliases":      counts,
		"aliases_path": s.aliases.Path(),
	})
}

func (s *Server) computeAbout() (*aboutStats, error) {
	a := s.a
	st := &aboutStats{
		ArchiveDir: a.Dir, DBPath: a.DBPath, DBSize: a.DBSize, InUse: a.InUse,
		DBModified:    time.Unix(0, a.DBMtime).UTC().Format(time.RFC3339),
		CacheDir:      s.cfg.CacheDir,
		Sessions:      []aboutSession{},
		Conversations: map[string]int{}, Users: map[string]int{},
	}
	if fi, err := os.Stat(s.IndexPath()); err == nil {
		st.IndexSize = fi.Size()
	}

	// sessions: one row per slackdump run (archive, resume, merge…)
	rows, err := a.DB.Query(`SELECT ID, CREATED_AT, UPDATED_AT, MODE, FINISHED, FILES_ENABLED, AVATARS_ENABLED, coalesce(ARGS,'') FROM SESSION ORDER BY ID`)
	if err == nil {
		for rows.Next() {
			var x aboutSession
			var c, u time.Time
			var args string
			if rows.Scan(&x.ID, &c, &u, &x.Mode, &x.Finished, &x.Files, &x.Avatars, &args) != nil {
				continue
			}
			x.Created, x.Updated = c.UTC().Format(time.RFC3339), u.UTC().Format(time.RFC3339)
			x.Command = "slackdump " + strings.ReplaceAll(args, "|", " ")
			st.Sessions = append(st.Sessions, x)
		}
		rows.Close()
	}

	db := s.ix.Load().DB
	f := func(bit int) string { return "sum(flags & " + itoa(bit) + " != 0)" }
	var first, last int64
	err = db.QueryRow(`SELECT count(*), coalesce(sum(top),0), coalesce(`+f(index.FlagReply)+`,0), coalesce(`+f(index.FlagParent)+`,0),
		coalesce(sum(CASE WHEN flags & `+itoa(index.FlagParent)+` != 0 THEN reply_count END),0),
		coalesce(`+f(index.FlagEdited)+`,0), coalesce(`+f(index.FlagPinned)+`,0), coalesce(`+f(index.FlagFile)+`,0),
		coalesce(`+f(index.FlagLink)+`,0), coalesce(`+f(index.FlagBot)+`,0), coalesce(min(id),0), coalesce(max(id),0)
		FROM msg WHERE flags & `+itoa(index.FlagHidden)+` = 0`).
		Scan(&st.Messages, &st.TopLevel, &st.Replies, &st.Threads, &st.Claimed, &st.Edited, &st.Pinned, &st.WithFiles, &st.WithLinks, &st.Bot, &first, &last)
	if err != nil {
		return nil, err
	}
	if st.Messages > 0 {
		st.FirstTS, st.LastTS = ts(first), ts(last)
	}
	// reactions: each row is one emoji on one message; users is a comma list
	_ = db.QueryRow(`SELECT coalesce(sum(length(users) - length(replace(users, ',', '')) + 1), 0) FROM reaction WHERE users != ''`).Scan(&st.Reactions)
	_ = db.QueryRow(`SELECT count(*), coalesce(sum(size),0) FROM (SELECT max(coalesce(size,0)) size FROM file GROUP BY file_id)`).Scan(&st.FilesDistinct, &st.FilesBytes)
	_ = db.QueryRow(`SELECT count(*) FROM file`).Scan(&st.FileRefs)

	if rows, err := db.Query(`SELECT strftime('%Y', id / 1000000, 'unixepoch', 'localtime'), count(*) FROM msg
		WHERE flags & ` + itoa(index.FlagHidden) + ` = 0 GROUP BY 1 ORDER BY 1`); err == nil {
		for rows.Next() {
			var y aboutYear
			if rows.Scan(&y.Year, &y.Count) == nil {
				st.ByYear = append(st.ByYear, y)
			}
		}
		rows.Close()
	}
	st.TopChannels = topN(db, `SELECT channel_id, total_count FROM channel_stat ORDER BY total_count DESC LIMIT 10`)
	st.TopPosters = topN(db, `SELECT user_id, count(*) n FROM msg WHERE user_id IS NOT NULL AND user_id != '' AND flags & `+itoa(index.FlagBot)+` = 0
		GROUP BY user_id ORDER BY n DESC LIMIT 10`)

	stats := s.dir.Stats()
	for id, c := range s.dir.channels {
		st.Conversations[c.Kind]++
		if c.IsArchived {
			st.Conversations["archived"]++
		}
		if stats[id].Total > 0 {
			st.Conversations["with_messages"]++
		}
	}
	for _, u := range s.dir.users {
		st.Users["total"]++
		switch {
		case u.IsBot || u.IsApp:
			st.Users["bots"]++
		case u.Deleted:
			st.Users["deactivated"]++
		default:
			st.Users["active"]++
		}
		if u.External {
			st.Users["external"]++
		}
	}
	if rows, err := db.Query(`SELECT DISTINCT user_id FROM msg WHERE user_id LIKE 'U%' OR user_id LIKE 'W%'`); err == nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				if _, ok := s.dir.users[id]; !ok {
					st.Unknown++
				}
			}
		}
		rows.Close()
	}

	st.LocalFiles, st.LocalBytes = dirUsage(a.Uploads)
	if a.Avatars != "" {
		st.Avatars, _ = dirUsage(a.Avatars)
	}
	st.CustomEmoji = len(s.emoji)
	return st, nil
}

func topN(db *sql.DB, q string) []aboutCount {
	out := []aboutCount{}
	rows, err := db.Query(q)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var c aboutCount
		if rows.Scan(&c.ID, &c.Count) == nil {
			out = append(out, c)
		}
	}
	return out
}

func itoa(i int) string { return strconv.Itoa(i) }

// dirUsage counts regular files under dir and their total size.
func dirUsage(dir string) (n int, bytes int64) {
	if dir == "" {
		return
	}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if fi, err := d.Info(); err == nil && fi.Mode().IsRegular() {
			n++
			bytes += fi.Size()
		}
		return nil
	})
	return
}
