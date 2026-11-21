package search

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/dkurth/slackdumpviewer/internal/index"
)

// Resolver maps names in filters to IDs.
type Resolver interface {
	Me() string
	// ResolveUsers returns all user IDs (including alias accounts) for a
	// reference like "@dkurth", "dkurth", "<@U123>", "U123", "me".
	ResolveUsers(ref string) []string
	// ResolveChannels returns channel IDs for "#general", "general", "<#C1|x>".
	ResolveChannels(ref string) []string
	// DMsWith returns IM/MPIM channel IDs whose members include any of users.
	DMsWith(users []string, onlyIM bool) []string
	// DMChannels returns all IM and MPIM channel IDs.
	DMChannels() []string
}

type Options struct {
	Sort   string // relevance | newest | oldest
	Offset int
	Limit  int
	Loc    *time.Location
	Now    time.Time
}

type Hit struct {
	RID      int64
	Channel  string
	ID       int64
	Chunk    int64
	ParentID int64 // 0 if not a reply
}

type Result struct {
	Total    int      `json:"total"`
	Hits     []Hit    `json:"-"`
	Terms    []string `json:"terms"` // positive words, for highlighting
	Warnings []string `json:"warnings,omitempty"`
}

// excluded from message search results (Slack hides these too)
var excludedSubtypes = []string{"channel_join", "channel_leave", "group_join", "group_leave", "bot_add", "bot_remove", "sh_room_created", "tombstone"}

type builder struct {
	where    []string
	args     []any
	warnings []string
}

func (b *builder) add(cond string, args ...any) {
	b.where = append(b.where, cond)
	b.args = append(b.args, args...)
}

func (b *builder) warn(f string, a ...any) { b.warnings = append(b.warnings, fmt.Sprintf(f, a...)) }

func placeholders(n int) string {
	if n == 0 {
		return "NULL"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func anys(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

func ftsQuote(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// MatchExprs returns FTS5 MATCH expressions for positive and negative terms.
func MatchExprs(terms []Term) (pos, neg string, words []string) {
	var p, n []string
	for _, t := range terms {
		e := ftsQuote(t.Text)
		if t.Prefix {
			e += "*"
		}
		if t.Negate {
			n = append(n, e)
		} else {
			p = append(p, e)
			words = append(words, splitWords(t.Text)...)
		}
	}
	return strings.Join(p, " "), strings.Join(n, " OR "), words
}

// filterClauses translates filters into SQL on msg alias "m".
func filterClauses(b *builder, q Query, r Resolver, o Options) {
	group := map[string][]Filter{}
	var order []string
	for _, f := range q.Filters {
		k := f.Key
		if f.Negate {
			k = "-" + k
		}
		if _, ok := group[k]; !ok {
			order = append(order, k)
		}
		group[k] = append(group[k], f)
	}
	for _, k := range order {
		fs := group[k]
		neg := fs[0].Negate
		not := ""
		if neg {
			not = "NOT "
		}
		switch fs[0].Key {
		case "from":
			var ids []string
			for _, f := range fs {
				u := r.ResolveUsers(f.Value)
				if len(u) == 0 {
					b.warn("Unknown person in from:%s", f.Value)
				}
				ids = append(ids, u...)
			}
			b.add(fmt.Sprintf("m.user_id %sIN (%s)", not, placeholders(len(ids))), anys(ids)...)
		case "in":
			var ids []string
			for _, f := range fs {
				v := f.Value
				var c []string
				if strings.HasPrefix(v, "@") || strings.HasPrefix(v, "<@") {
					c = r.DMsWith(r.ResolveUsers(v), true)
				} else {
					c = r.ResolveChannels(v)
					if len(c) == 0 {
						if us := r.ResolveUsers(v); len(us) > 0 {
							c = r.DMsWith(us, true)
						}
					}
				}
				if len(c) == 0 {
					b.warn("Unknown conversation in in:%s", v)
				}
				ids = append(ids, c...)
			}
			b.add(fmt.Sprintf("m.channel_id %sIN (%s)", not, placeholders(len(ids))), anys(ids)...)
		case "with":
			for _, f := range fs {
				us := r.ResolveUsers(f.Value)
				if len(us) == 0 {
					b.warn("Unknown person in with:%s", f.Value)
				}
				dms := r.DMsWith(us, false)
				cond := fmt.Sprintf(`(m.channel_id IN (%s) OR EXISTS (
					SELECT 1 FROM msg t WHERE t.channel_id = m.channel_id
					  AND (t.parent_id = coalesce(m.parent_id, m.id) OR (t.id = coalesce(m.parent_id, m.id) AND t.flags & %d))
					  AND t.user_id IN (%s)))`, placeholders(len(dms)), index.FlagParent, placeholders(len(us)))
				args := append(anys(dms), anys(us)...)
				if neg {
					cond = "NOT " + cond
				}
				b.add(cond, args...)
			}
		case "to":
			for _, f := range fs {
				us := r.ResolveUsers(f.Value)
				if len(us) == 0 {
					b.warn("Unknown person in to:%s", f.Value)
				}
				dms := r.DMsWith(us, true)
				cond := fmt.Sprintf(`(m.rid IN (SELECT rid FROM mention WHERE user_id IN (%s))
					OR (m.channel_id IN (%s) AND coalesce(m.user_id,'') NOT IN (%s)))`,
					placeholders(len(us)), placeholders(len(dms)), placeholders(len(us)))
				args := append(append(anys(us), anys(dms)...), anys(us)...)
				if neg {
					cond = "NOT " + cond
				}
				b.add(cond, args...)
			}
		case "before", "after", "on", "during":
			for _, f := range fs {
				start, end, ok := DateRange(f.Value, o.Now, o.Loc)
				if !ok {
					b.warn("Couldn't understand the date in %s:%s", f.Key, f.Value)
					continue
				}
				s, e := start.UnixMicro(), end.UnixMicro()
				var cond string
				var args []any
				switch f.Key {
				case "before":
					cond, args = "m.id < ?", []any{s}
				case "after":
					cond, args = "m.id >= ?", []any{e}
				default:
					cond, args = "(m.id >= ? AND m.id < ?)", []any{s, e}
				}
				if f.Negate {
					cond = "NOT " + cond
				}
				b.add(cond, args...)
			}
		case "has":
			for _, f := range fs {
				v := strings.ToLower(f.Value)
				var cond string
				var args []any
				switch {
				case v == "link" || v == "links" || v == "url":
					cond = fmt.Sprintf("m.flags & %d", index.FlagLink)
				case v == "file" || v == "files" || v == "attachment":
					cond = fmt.Sprintf("m.flags & %d", index.FlagFile)
				case v == "pin" || v == "pins" || v == "pinned":
					cond = fmt.Sprintf("m.flags & %d", index.FlagPinned)
				case v == "reaction" || v == "reactions":
					cond = fmt.Sprintf("m.flags & %d", index.FlagReaction)
				case strings.HasPrefix(v, ":") && strings.HasSuffix(v, ":") && len(v) > 2:
					name := strings.Trim(v, ":")
					cond, args = "m.rid IN (SELECT rid FROM reaction WHERE name = ? OR name LIKE ? || '::skin-tone-%')", []any{name, name}
				case v == "star" || v == "stars":
					b.warn("has:star isn't available: stars aren't in the archive")
					continue
				default:
					b.warn("Unknown has:%s", f.Value)
					continue
				}
				if f.Negate {
					cond = "NOT (" + cond + ")"
				}
				b.add(cond, args...)
			}
		case "is":
			for _, f := range fs {
				v := strings.ToLower(f.Value)
				var cond string
				var args []any
				switch v {
				case "thread":
					cond = fmt.Sprintf("m.flags & %d", index.FlagReply|index.FlagParent)
				case "dm", "dms", "im":
					dms := r.DMChannels()
					cond, args = fmt.Sprintf("m.channel_id IN (%s)", placeholders(len(dms))), anys(dms)
				case "pinned":
					cond = fmt.Sprintf("m.flags & %d", index.FlagPinned)
				case "edited":
					cond = fmt.Sprintf("m.flags & %d", index.FlagEdited)
				case "bot":
					cond = fmt.Sprintf("m.flags & %d", index.FlagBot)
				case "saved", "starred":
					b.warn("is:%s isn't available: saved items aren't in the archive", v)
					continue
				default:
					b.warn("Unknown is:%s", f.Value)
					continue
				}
				if f.Negate {
					cond = "NOT (" + cond + ")"
				}
				b.add(cond, args...)
			}
		}
	}
}

// Messages runs a message search.
func Messages(db *sql.DB, q Query, r Resolver, o Options) (Result, error) {
	if o.Limit <= 0 {
		o.Limit = 20
	}
	if o.Loc == nil {
		o.Loc = time.Local
	}
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	b := &builder{}
	pos, neg, words := MatchExprs(q.Terms)
	res := Result{Terms: words}
	if pos == "" && neg == "" && len(q.Filters) == 0 {
		return res, nil
	}
	from := "msg m"
	var matchArgs []any
	if pos != "" {
		from = "msg_fts JOIN msg m ON m.rid = msg_fts.rowid"
		b.add("msg_fts MATCH ?", pos)
	}
	if neg != "" {
		b.add("m.rid NOT IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)", neg)
	}
	b.add(fmt.Sprintf("coalesce(m.subtype,'') NOT IN (%s)", placeholders(len(excludedSubtypes))), anys(excludedSubtypes)...)
	filterClauses(b, q, r, o)
	_ = matchArgs
	where := strings.Join(b.where, " AND ")
	res.Warnings = b.warnings

	if err := db.QueryRow("SELECT count(*) FROM "+from+" WHERE "+where, b.args...).Scan(&res.Total); err != nil {
		return res, fmt.Errorf("search count: %w", err)
	}
	orderBy := "m.id DESC"
	switch {
	case o.Sort == "oldest":
		orderBy = "m.id ASC"
	case o.Sort == "newest":
	case pos != "":
		// Relevance: bm25 with a mild recency tie-break.
		orderBy = "bm25(msg_fts) ASC, m.id DESC"
	}
	sqlq := "SELECT m.rid, m.channel_id, m.id, m.chunk_id, coalesce(m.parent_id, 0) FROM " + from +
		" WHERE " + where + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?"
	args := append(append([]any{}, b.args...), o.Limit, o.Offset)
	rows, err := db.Query(sqlq, args...)
	if err != nil {
		return res, fmt.Errorf("search: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.RID, &h.Channel, &h.ID, &h.Chunk, &h.ParentID); err != nil {
			return res, err
		}
		res.Hits = append(res.Hits, h)
	}
	return res, rows.Err()
}

type FileHit struct {
	FileID   string `json:"id"`
	Channel  string `json:"channel"`
	TS       string `json:"ts"`
	User     string `json:"user,omitempty"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Filetype string `json:"filetype,omitempty"`
	Mimetype string `json:"mimetype,omitempty"`
	Size     int64  `json:"size"`
	Mode     string `json:"mode,omitempty"`
	ParentTS string `json:"thread_ts,omitempty"`
	Local    bool   `json:"local"`
}

type FileResult struct {
	Total    int       `json:"total"`
	Files    []FileHit `json:"files"`
	Warnings []string  `json:"warnings,omitempty"`
}

// Files searches file names/titles with the same filters (applied to the
// message that carries the file).
func Files(db *sql.DB, q Query, r Resolver, o Options) (FileResult, error) {
	if o.Limit <= 0 {
		o.Limit = 20
	}
	if o.Loc == nil {
		o.Loc = time.Local
	}
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	b := &builder{}
	pos, neg, _ := MatchExprs(q.Terms)
	from := "file f JOIN msg m ON m.rid = f.rid"
	if pos != "" {
		from = "file_fts JOIN file f ON f.fid = file_fts.rowid JOIN msg m ON m.rid = f.rid"
		b.add("file_fts MATCH ?", pos)
	}
	if neg != "" {
		b.add("f.fid NOT IN (SELECT rowid FROM file_fts WHERE file_fts MATCH ?)", neg)
	}
	b.add("f.mode != 'tombstone'")
	filterClauses(b, q, r, o)
	where := strings.Join(b.where, " AND ")
	out := FileResult{Warnings: b.warnings}
	if err := db.QueryRow("SELECT count(*) FROM "+from+" WHERE "+where, b.args...).Scan(&out.Total); err != nil {
		return out, err
	}
	orderBy := "m.id DESC"
	if o.Sort == "oldest" {
		orderBy = "m.id ASC"
	} else if o.Sort == "relevance" && pos != "" {
		orderBy = "bm25(file_fts) ASC, m.id DESC"
	}
	rows, err := db.Query(`SELECT f.file_id, f.channel_id, f.id, coalesce(f.user_id,''), coalesce(f.name,''), coalesce(f.title,''),
		coalesce(f.filetype,''), coalesce(f.mimetype,''), coalesce(f.size,0), coalesce(f.mode,''), coalesce(m.parent_id,0)
		FROM `+from+" WHERE "+where+" ORDER BY "+orderBy+" LIMIT ? OFFSET ?", append(append([]any{}, b.args...), o.Limit, o.Offset)...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var h FileHit
		var id, parent int64
		if err := rows.Scan(&h.FileID, &h.Channel, &id, &h.User, &h.Name, &h.Title, &h.Filetype, &h.Mimetype, &h.Size, &h.Mode, &parent); err != nil {
			return out, err
		}
		h.TS = TS(id)
		if parent != 0 {
			h.ParentTS = TS(parent)
		}
		out.Files = append(out.Files, h)
	}
	return out, rows.Err()
}

// TS converts a microsecond id to Slack's "seconds.micros" ts string.
func TS(id int64) string { return fmt.Sprintf("%d.%06d", id/1_000_000, id%1_000_000) }

// Dedup returns unique strings, sorted.
func Dedup(ss []string) []string {
	m := map[string]bool{}
	for _, s := range ss {
		m[s] = true
	}
	out := make([]string, 0, len(m))
	for s := range m {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
