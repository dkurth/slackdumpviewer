package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/dkurth/slackdumpviewer/internal/aliases"
	"github.com/dkurth/slackdumpviewer/internal/archive"
	"github.com/dkurth/slackdumpviewer/internal/index"
	"github.com/dkurth/slackdumpviewer/internal/search"
)

// ---- bootstrap ----

type channelOut struct {
	*archive.Channel
	ChannelStat
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	stats := s.dir.Stats()
	chans := make([]channelOut, 0, len(s.dir.channels))
	for id, c := range s.dir.channels {
		chans = append(chans, channelOut{c, stats[id]})
	}
	sort.Slice(chans, func(i, j int) bool { return chans[i].ID < chans[j].ID })
	users := make([]*archive.User, 0, len(s.dir.users))
	for _, u := range s.dir.users {
		users = append(users, u)
	}
	sort.Slice(users, func(i, j int) bool { return users[i].ID < users[j].ID })
	avatars := []string{}
	if s.a.Avatars != "" {
		if ents, err := os.ReadDir(s.a.Avatars); err == nil {
			for _, e := range ents {
				if e.IsDir() {
					avatars = append(avatars, e.Name())
				}
			}
		}
	}
	emoji := map[string]string{}
	for name, v := range s.emoji {
		if strings.HasPrefix(v, "alias:") {
			emoji[name] = v
		} else {
			emoji[name] = "/emoji/" + name
		}
	}
	writeJSON(w, 200, map[string]any{
		"workspace":    s.ws,
		"me":           s.ws.UserID,
		"users":        users,
		"channels":     chans,
		"avatars":      avatars,
		"custom_emoji": emoji,
		"aliases":      s.aliases.Snapshot(),
		"in_use":       s.a.InUse,
		"archive_dir":  s.a.Dir,
	})
}

// ---- messages ----

func qInt(r *http.Request, k string, def, lo, hi int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(k))
	if err != nil {
		return def
	}
	return min(max(v, lo), hi)
}

func (s *Server) queryRows(q string, args ...any) ([]msgRow, error) {
	rows, err := s.ix.Load().DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []msgRow
	for rows.Next() {
		var m msgRow
		if err := rows.Scan(&m.Channel, &m.ID, &m.Chunk, &m.Parent); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func reverse[T any](s []T) {
	for i, j := 0, len(s)-1; i < j; i, j = i+1, j-1 {
		s[i], s[j] = s[j], s[i]
	}
}

const rowCols = `channel_id, id, chunk_id, coalesce(parent_id, 0)`

// GET /api/messages?channel=C&before=ts|after=ts|around=ts&limit=n
// Returns top-level messages in ascending order.
func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ch := q.Get("channel")
	if _, ok := s.dir.channels[ch]; !ok {
		if _, ok := s.dir.Stats()[ch]; !ok {
			writeErr(w, 404, "unknown conversation")
			return
		}
	}
	limit := qInt(r, "limit", 60, 1, 300)
	var rows []msgRow
	var err error
	moreBefore, moreAfter := false, false
	base := `SELECT ` + rowCols + ` FROM msg WHERE channel_id = ? AND top = 1 `
	switch {
	case q.Get("around") != "":
		id, ok := parseTS(q.Get("around"))
		if !ok {
			writeErr(w, 400, "bad ts")
			return
		}
		half := limit / 2
		var before, after []msgRow
		before, err = s.queryRows(base+`AND id < ? ORDER BY id DESC LIMIT ?`, ch, id, half+1)
		if err == nil {
			after, err = s.queryRows(base+`AND id >= ? ORDER BY id ASC LIMIT ?`, ch, id, limit-half+1)
		}
		if len(before) > half {
			before, moreBefore = before[:half], true
		}
		if len(after) > limit-half {
			after, moreAfter = after[:limit-half], true
		}
		reverse(before)
		rows = append(before, after...)
	case q.Get("after") != "":
		id, ok := parseTS(q.Get("after"))
		if !ok {
			writeErr(w, 400, "bad ts")
			return
		}
		rows, err = s.queryRows(base+`AND id > ? ORDER BY id ASC LIMIT ?`, ch, id, limit+1)
		if len(rows) > limit {
			rows, moreAfter = rows[:limit], true
		}
		moreBefore = true
	default:
		before := int64(1 << 62)
		if b := q.Get("before"); b != "" {
			id, ok := parseTS(b)
			if !ok {
				writeErr(w, 400, "bad ts")
				return
			}
			before = id
			moreAfter = true
		}
		rows, err = s.queryRows(base+`AND id < ? ORDER BY id DESC LIMIT ?`, ch, before, limit+1)
		if len(rows) > limit {
			rows, moreBefore = rows[:limit], true
		}
		reverse(rows)
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	msgs, err := s.loadMessages(rows)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.annotateReplies(ch, msgs)
	writeJSON(w, 200, map[string]any{"messages": msgs, "has_more_before": moreBefore, "has_more_after": moreAfter})
}

// annotateReplies adds "_archived_replies" and "_reply_users_archived" to thread parents.
func (s *Server) annotateReplies(ch string, msgs []map[string]any) {
	var ids []any
	idx := map[int64]map[string]any{}
	for _, m := range msgs {
		if rc, _ := m["reply_count"].(float64); rc > 0 {
			if t, _ := m["ts"].(string); t != "" {
				if id, ok := parseTS(t); ok {
					ids = append(ids, id)
					idx[id] = m
				}
			}
		}
	}
	if len(ids) == 0 {
		return
	}
	q := `SELECT parent_id, count(*) FROM msg WHERE channel_id = ? AND parent_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + `) GROUP BY parent_id`
	rows, err := s.ix.Load().DB.Query(q, append([]any{ch}, ids...)...)
	if err != nil {
		return
	}
	defer rows.Close()
	for _, m := range idx {
		m["_archived_replies"] = 0
	}
	for rows.Next() {
		var pid int64
		var n int
		if rows.Scan(&pid, &n) == nil {
			if m := idx[pid]; m != nil {
				m["_archived_replies"] = n
			}
		}
	}
}

// GET /api/thread?channel=C&ts=parent
func (s *Server) handleThread(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ch := q.Get("channel")
	id, ok := parseTS(q.Get("ts"))
	if !ok {
		writeErr(w, 400, "bad ts")
		return
	}
	rows, err := s.queryRows(`SELECT `+rowCols+` FROM msg WHERE channel_id = ? AND (id = ? OR parent_id = ?) ORDER BY id`, ch, id, id)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	msgs, err := s.loadMessages(rows)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	var parent map[string]any
	replies := []map[string]any{}
	for _, m := range msgs {
		if t, _ := m["ts"].(string); t != "" {
			if mid, _ := parseTS(t); mid == id {
				parent = m
				continue
			}
		}
		replies = append(replies, m)
	}
	writeJSON(w, 200, map[string]any{"parent": parent, "replies": replies})
}

// GET /api/message?channel=C&ts=T — locate a message (for permalinks):
// returns its thread parent if it's a reply.
func (s *Server) handleMessageLookup(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ch := q.Get("channel")
	id, ok := parseTS(q.Get("ts"))
	if !ok {
		writeErr(w, 400, "bad ts")
		return
	}
	var parent sql.NullInt64
	var top int
	err := s.ix.Load().DB.QueryRow(`SELECT parent_id, top FROM msg WHERE channel_id = ? AND id = ?`, ch, id).Scan(&parent, &top)
	if err == sql.ErrNoRows {
		writeJSON(w, 200, map[string]any{"found": false})
		return
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	out := map[string]any{"found": true, "top": top == 1}
	if parent.Valid {
		out["thread_ts"] = ts(parent.Int64)
	}
	writeJSON(w, 200, out)
}

// GET /api/conversation?channel=C — details: pins, counts.
func (s *Server) handleConversation(w http.ResponseWriter, r *http.Request) {
	ch := r.URL.Query().Get("channel")
	c, ok := s.dir.channels[ch]
	if !ok {
		writeErr(w, 404, "unknown conversation")
		return
	}
	rows, err := s.queryRows(`SELECT `+rowCols+` FROM msg WHERE channel_id = ? AND flags & ? ORDER BY id DESC LIMIT 200`, ch, index.FlagPinned)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	pins, err := s.loadMessages(rows)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	var files int
	s.ix.Load().DB.QueryRow(`SELECT count(*) FROM file WHERE channel_id = ? AND mode != 'tombstone'`, ch).Scan(&files)
	writeJSON(w, 200, map[string]any{"channel": c, "stats": s.dir.Stats()[ch], "pins": pins, "file_count": files})
}

// GET /api/conversation/files?channel=C&offset=n
func (s *Server) handleConversationFiles(w http.ResponseWriter, r *http.Request) {
	q := search.Query{Filters: []search.Filter{{Key: "in", Value: r.URL.Query().Get("channel")}}}
	res, err := search.Files(s.ix.Load().DB, q, s.dir, search.Options{Sort: "newest", Offset: qInt(r, "offset", 0, 0, 1e9), Limit: qInt(r, "limit", 50, 1, 200)})
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.markLocal(res.Files)
	writeJSON(w, 200, res)
}

func (s *Server) markLocal(files []search.FileHit) {
	for i := range files {
		_, files[i].Local = s.a.UploadPath(files[i].FileID, files[i].Name)
	}
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// ---- search ----

func (s *Server) searchOpts(r *http.Request) search.Options {
	q := r.URL.Query()
	loc := time.Local
	if tz := q.Get("tz"); tz != "" {
		if l, err := time.LoadLocation(tz); err == nil {
			loc = l
		}
	}
	sortBy := q.Get("sort")
	if sortBy == "" {
		sortBy = "relevance"
	}
	return search.Options{
		Sort: sortBy, Loc: loc, Now: time.Now(),
		Offset: qInt(r, "offset", 0, 0, 1e9), Limit: qInt(r, "limit", 20, 1, 100),
	}
}

// GET /api/search?q=&sort=&offset=&limit=&tz=
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	query := search.Parse(r.URL.Query().Get("q"))
	res, err := search.Messages(s.ix.Load().DB, query, s.dir, s.searchOpts(r))
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	rows := make([]msgRow, len(res.Hits))
	for i, h := range res.Hits {
		rows[i] = msgRow{Channel: h.Channel, ID: h.ID, Chunk: h.Chunk, Parent: h.ParentID}
	}
	msgs, err := s.loadMessages(rows)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"total": res.Total, "messages": msgs, "terms": res.Terms, "warnings": res.Warnings, "parsed": query})
}

// GET /api/search/files?q=
func (s *Server) handleSearchFiles(w http.ResponseWriter, r *http.Request) {
	query := search.Parse(r.URL.Query().Get("q"))
	o := s.searchOpts(r)
	if r.URL.Query().Get("sort") == "" {
		o.Sort = "newest"
	}
	res, err := search.Files(s.ix.Load().DB, query, s.dir, o)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.markLocal(res.Files)
	writeJSON(w, 200, res)
}

// ---- unknown users & aliases ----

type unknownUser struct {
	ID       string          `json:"id"`
	Messages int             `json:"messages"`
	Channels int             `json:"channels"`
	First    string          `json:"first_ts"`
	Last     string          `json:"last_ts"`
	DM       string          `json:"dm,omitempty"`
	Alias    *aliases.Entry  `json:"alias,omitempty"`
	TopChans []string        `json:"top_channels,omitempty"`
	Extra    json.RawMessage `json:"-"`
}

func (s *Server) handleUnknownUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.ix.Load().DB.Query(`SELECT user_id, count(*), count(DISTINCT channel_id), min(id), max(id)
		FROM msg WHERE user_id IS NOT NULL AND (user_id LIKE 'U%' OR user_id LIKE 'W%') GROUP BY user_id`)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	al := s.aliases.Snapshot()
	dms := map[string]string{}
	for id, c := range s.dir.channels {
		if c.Kind == "im" && c.IMUser != "" {
			dms[c.IMUser] = id
		}
	}
	out := []unknownUser{}
	for rows.Next() {
		var u unknownUser
		var f, l int64
		if err := rows.Scan(&u.ID, &u.Messages, &u.Channels, &f, &l); err != nil {
			continue
		}
		if _, known := s.dir.users[u.ID]; known {
			continue
		}
		u.First, u.Last, u.DM = ts(f), ts(l), dms[u.ID]
		if e, ok := al[u.ID]; ok {
			e := e
			u.Alias = &e
		}
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Messages > out[j].Messages })
	writeJSON(w, 200, map[string]any{"users": out})
}

func (s *Server) handleAliasesGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"aliases": s.aliases.Snapshot(), "path": s.aliases.Path()})
}

// PUT /api/aliases/{id} {status, maps_to, name}
func (s *Server) handleAliasPut(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !reIDish.MatchString(id) {
		writeErr(w, 400, "bad id")
		return
	}
	var in aliases.Entry
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	switch in.Status {
	case aliases.Confirmed, aliases.Rejected, aliases.Suggested:
	default:
		writeErr(w, 400, "bad status")
		return
	}
	if in.MapsTo != "" && s.dir.users[in.MapsTo] == nil {
		writeErr(w, 400, "maps_to must be a known user")
		return
	}
	cur := s.aliases.Snapshot()[id]
	cur.Status, cur.MapsTo, cur.Name = in.Status, in.MapsTo, in.Name
	if err := s.aliases.Set(id, cur); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "alias": cur})
}
