package server

import (
	"database/sql"
	"regexp"
	"strings"
	"sync"

	"github.com/dkurth/slackdumpviewer/internal/aliases"
	"github.com/dkurth/slackdumpviewer/internal/archive"
)

// Directory holds users and channels and resolves names for search.
type Directory struct {
	me       string
	users    map[string]*archive.User
	channels map[string]*archive.Channel
	aliases  *aliases.Store

	mu    sync.RWMutex
	stats map[string]ChannelStat
}

type ChannelStat struct {
	Count  int    `json:"count"`
	Total  int    `json:"total"`
	First  string `json:"first_ts,omitempty"`
	Latest string `json:"latest_ts,omitempty"`
}

func NewDirectory(me string, users map[string]*archive.User, chans map[string]*archive.Channel, al *aliases.Store) *Directory {
	return &Directory{me: me, users: users, channels: chans, aliases: al, stats: map[string]ChannelStat{}}
}

func (d *Directory) LoadStats(db *sql.DB) error {
	rows, err := db.Query(`SELECT channel_id, top_count, total_count, first_id, last_id FROM channel_stat`)
	if err != nil {
		return err
	}
	defer rows.Close()
	st := map[string]ChannelStat{}
	for rows.Next() {
		var id string
		var c, t int
		var f, l int64
		if err := rows.Scan(&id, &c, &t, &f, &l); err != nil {
			return err
		}
		st[id] = ChannelStat{Count: c, Total: t, First: ts(f), Latest: ts(l)}
	}
	d.mu.Lock()
	d.stats = st
	d.mu.Unlock()
	return rows.Err()
}

func (d *Directory) Stats() map[string]ChannelStat {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.stats
}

// ---- index.Names ----

func (d *Directory) UserName(id string) string {
	if u, ok := d.users[id]; ok {
		if u.DisplayName != "" && u.RealName != "" && u.DisplayName != u.RealName {
			return u.DisplayName + " " + u.RealName
		}
		if u.DisplayName != "" {
			return u.DisplayName
		}
		if u.RealName != "" {
			return u.RealName
		}
		return u.Name
	}
	return ""
}

func (d *Directory) ChannelName(id string) string {
	if c, ok := d.channels[id]; ok {
		return c.Name
	}
	return ""
}

// ---- search.Resolver ----

func (d *Directory) Me() string { return d.me }

var (
	reUserRef = regexp.MustCompile(`^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$`)
	reChanRef = regexp.MustCompile(`^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$`)
	reIDish   = regexp.MustCompile(`^[UWBCGD][A-Z0-9]{6,}$`)
)

func norm(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.NewReplacer(" ", "", ".", "", "-", "", "_", "").Replace(s)
}

// ResolveUsers resolves a user reference, then expands through confirmed aliases.
func (d *Directory) ResolveUsers(ref string) []string {
	ref = strings.TrimSpace(ref)
	var ids []string
	if m := reUserRef.FindStringSubmatch(ref); m != nil {
		ids = []string{m[1]}
	} else {
		r := strings.TrimPrefix(ref, "@")
		up := strings.ToUpper(r)
		switch {
		case strings.EqualFold(r, "me"):
			ids = []string{d.me}
		case d.users[up] != nil:
			ids = []string{up}
		default:
			n := norm(r)
			// exact handle first, then display/real names
			for id, u := range d.users {
				if strings.EqualFold(u.Name, r) {
					ids = append(ids, id)
				}
			}
			if len(ids) == 0 {
				for id, u := range d.users {
					if n != "" && (norm(u.DisplayName) == n || norm(u.RealName) == n) {
						ids = append(ids, id)
					}
				}
			}
			// alias names (for old accounts with only a name)
			for id, e := range d.aliases.Snapshot() {
				if e.Status == aliases.Confirmed && e.Name != "" && norm(e.Name) == n {
					ids = append(ids, id)
				}
			}
			// an ID of an account without a profile
			if len(ids) == 0 && reIDish.MatchString(up) {
				ids = []string{up}
			}
		}
	}
	return d.expand(ids)
}

func (d *Directory) expand(ids []string) []string {
	groups := d.aliases.Groups(false)
	seen := map[string]bool{}
	var out []string
	for _, id := range ids {
		g := groups[id]
		if g == nil {
			g = []string{id}
		}
		for _, x := range g {
			if !seen[x] {
				seen[x] = true
				out = append(out, x)
			}
		}
	}
	return out
}

func (d *Directory) ResolveChannels(ref string) []string {
	ref = strings.TrimSpace(ref)
	if m := reChanRef.FindStringSubmatch(ref); m != nil {
		return []string{m[1]}
	}
	r := strings.TrimPrefix(ref, "#")
	if c, ok := d.channels[strings.ToUpper(r)]; ok {
		return []string{c.ID}
	}
	var out []string
	for id, c := range d.channels {
		if c.Kind != "im" && strings.EqualFold(c.Name, r) {
			out = append(out, id)
		}
	}
	return out
}

func (d *Directory) DMsWith(users []string, onlyIM bool) []string {
	set := map[string]bool{}
	for _, u := range users {
		set[u] = true
	}
	var out []string
	for id, c := range d.channels {
		switch c.Kind {
		case "im":
			if set[c.IMUser] {
				out = append(out, id)
			}
		case "mpim":
			if onlyIM {
				continue
			}
			for _, m := range c.Members {
				if set[m] {
					out = append(out, id)
					break
				}
			}
		}
	}
	return out
}

func (d *Directory) DMChannels() []string {
	var out []string
	for id, c := range d.channels {
		if c.Kind == "im" || c.Kind == "mpim" {
			out = append(out, id)
		}
	}
	return out
}
