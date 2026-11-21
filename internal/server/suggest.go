package server

import (
	"database/sql"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/dkurth/slackdumpviewer/internal/aliases"
	"github.com/dkurth/slackdumpviewer/internal/archive"
)

// Alias suggestions for user IDs that have no profile.
//
// The main signal is what people call them: greetings in DMs with the
// account ("Hey Brandon, …"), replies right after their messages
// ("Thanks Brandon!"), and vocatives ("Brandon, can you…"). Names are matched
// to current users' first names; ties (two Brandons) are broken by channel
// overlap and recent activity. Without a matching current user, we suggest
// the name alone.

var (
	reGreet    = regexp.MustCompile(`^\s*(?:@\S+(?:\s+\S+)?\s+)?(?i:hey|hi|hello|hiya|howdy|thanks|thank you|thx|ty|morning|good morning|good afternoon|good evening|ok|okay|sure|great|cool|sorry|congrats|congratulations|welcome back|welcome|nice|yes|no|yeah|yep|awesome|perfect|yo|dear|bye|night|cheers)[\s,!.]+([A-Z][\p{L}'’\-]+)\b`)
	reVocative = regexp.MustCompile(`^\s*([A-Z][\p{L}'’\-]+)\s*[,:—–-]\s`)
	stopNames  = map[string]bool{}
)

func init() {
	for _, w := range strings.Fields(`I I'm I'll I've I'd The This That These Those It It's We You Your OK Ok Okay So And But Sure Also Just All Everyone Everybody Guys Team Folks There Here Man Dude Sir Buddy Thanks Thank Yes No Yeah Yep Hey Hi Hello What When Where Why How Who Which If Then Now Well Oh Ah Lol Haha Great Good Cool Nice Sorry Please Let Can Could Would Should Will Did Do Does Is Are Was Were Has Have Had Not Any Some One Two Three Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December Today Tomorrow Yesterday Morning Afternoon Evening Night Friend Friends Mate Boss Gents Ladies Y'all Yall Again Back Both Each FYI Also Looks Like Ugh Wow Agreed Absolutely Totally Right Done Screenshot Screen Image Photo File Link Alright Awesome Yea Whew Huh Massive Posted First Congratulations Congrats Books They Car News Champagne Exactly Indeed Definitely Seriously Honestly Fantastic Amazing Excellent Wonderful Brilliant Interesting Correct Understood Noted Gotcha Got Ack Roger Copy Fine Fair Nevermind Oops Whoops Yikes Darn Dang Shoot Weird Strange Funny Love Happy Merry Welcome Hello Hey Hiya Howdy Morning Btw Also PS Update Question Note Re Ha Hmm Hm Um Uh Since After Before For From With About Thats Yup Nope Np Sounds Same Me Him Her Them Us Our My His Their Everything Anything Nothing Something Whatever Anyway Plus Also`) {
		stopNames[strings.ToLower(w)] = true
	}
}

type nameHit struct {
	count   int
	example string
}

type acct struct {
	id       string
	msgs     int
	first    int64
	last     int64
	channels map[string]int
	names    map[string]*nameHit
	total    int // total addressing hits
}

func firstName(u *archive.User) []string {
	var out []string
	for _, n := range []string{u.RealName, u.DisplayName} {
		f := strings.FieldsFunc(n, func(r rune) bool { return unicode.IsSpace(r) || r == '.' || r == '_' })
		if len(f) > 0 {
			out = append(out, strings.ToLower(f[0]))
		}
	}
	if u.Name != "" && !strings.ContainsAny(u.Name, ".-_") {
		out = append(out, strings.ToLower(u.Name))
	}
	return out
}

func snippet(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > 80 {
		s = string([]rune(s)[:80]) + "…"
	}
	return s
}

var reTitle = regexp.MustCompile(`^\p{Lu}\p{Ll}+(?:['’\-]\p{Lu}?\p{Ll}+)?$`)

// extractNames returns candidate addressee names at the start of text.
// target is the account being addressed; known reports whether a word is
// some user's first name. Greetings ("Thanks Brandon") accept any
// Title-case word; the comma form ("Brandon, …") only known first names.
// If the message starts by @-mentioning someone else, the name belongs to
// them, so it's skipped.
func extractNames(text, target string, known func(string) bool) []string {
	head := strings.TrimSpace(text)
	if len(head) > 200 {
		head = head[:200]
	}
	if strings.HasPrefix(head, "@") {
		first := strings.Fields(head)[0]
		if strings.TrimPrefix(first, "@") != target {
			return nil
		}
	}
	var out []string
	add := func(n string, needKnown bool) {
		n = strings.TrimRight(n, "'’-")
		low := strings.ToLower(n)
		if len([]rune(n)) < 2 || stopNames[low] || !reTitle.MatchString(n) {
			return
		}
		if needKnown && !known(low) {
			return
		}
		out = append(out, n)
	}
	if m := reGreet.FindStringSubmatch(head); m != nil {
		add(m[1], false)
	} else if m := reVocative.FindStringSubmatch(head); m != nil {
		add(m[1], true)
	}
	return out
}

// SuggestAliases computes suggestions and merges them into aliases.json
// (confirmed/rejected entries are kept). Returns the number of suggestions.
func (s *Server) SuggestAliases() (int, error) {
	ix := s.ix.Load()
	if ix == nil {
		return 0, fmt.Errorf("index not ready")
	}
	return s.suggestWith(ix.DB)
}

func (s *Server) suggestWith(db *sql.DB) (int, error) {
	users := s.dir.users
	isUnknown := func(id string) bool {
		if id == "" || users[id] != nil {
			return false
		}
		return id[0] == 'U' || id[0] == 'W'
	}

	// Pass 1: per-account stats; remember which rows need text.
	rows, err := db.Query(`SELECT rid, channel_id, coalesce(parent_id, 0), id, coalesce(user_id, '') FROM msg ORDER BY channel_id, coalesce(parent_id, id), id`)
	if err != nil {
		return 0, err
	}
	accts := map[string]*acct{}
	get := func(id string) *acct {
		a := accts[id]
		if a == nil {
			a = &acct{id: id, channels: map[string]int{}, names: map[string]*nameHit{}, first: math.MaxInt64}
			accts[id] = a
		}
		return a
	}
	// IM channel -> unknown partner
	imPartner := map[string]string{}
	for id, c := range s.dir.channels {
		if c.Kind == "im" && isUnknown(c.IMUser) {
			imPartner[id] = c.IMUser
		}
	}
	type need struct {
		rid    int64
		target string // unknown being addressed
		ch     string
		id     int64
	}
	var needs []need
	// "Previous message": for top-level messages, the previous top-level
	// message in the channel; for replies, the previous message in the
	// thread (the parent for the first reply).
	var curCh, topUser, prevUser string
	var topID, prevKey, prevID int64
	for rows.Next() {
		var rid, parent, id int64
		var ch, user string
		if err := rows.Scan(&rid, &ch, &parent, &id, &user); err != nil {
			rows.Close()
			return 0, err
		}
		if ch != curCh {
			curCh, topUser, topID, prevUser, prevKey, prevID = ch, "", 0, "", 0, 0
		}
		key := parent
		if key == 0 {
			key = id
		}
		if user != "" {
			a := get(user)
			a.msgs++
			a.channels[ch]++
			a.first = min(a.first, id)
			a.last = max(a.last, id)
		}
		var before string
		var beforeID int64
		if parent == 0 {
			before, beforeID = topUser, topID
		} else if prevKey == key {
			before, beforeID = prevUser, prevID
		}
		if p, ok := imPartner[ch]; ok && user != p && user != "" {
			needs = append(needs, need{rid, p, ch, id})
		} else if isUnknown(before) && user != before && user != "" && id-beforeID < int64(2*time.Hour/time.Microsecond) {
			needs = append(needs, need{rid, before, ch, id})
		}
		if parent == 0 {
			topUser, topID = user, id
		}
		prevUser, prevKey, prevID = user, key, id
	}
	rows.Close()

	// Index current users by first name.
	byFirst := map[string][]*archive.User{}
	for _, u := range users {
		if u.IsBot || u.IsApp || u.ID == "USLACKBOT" {
			continue
		}
		seen := map[string]bool{}
		for _, f := range firstName(u) {
			if !seen[f] {
				seen[f] = true
				byFirst[f] = append(byFirst[f], u)
			}
		}
	}

	knownFirst := func(n string) bool { return len(byFirst[n]) > 0 }

	// Pass 2: read the bodies we need and extract names.
	const batch = 500
	for i := 0; i < len(needs); i += batch {
		chunk := needs[i:min(i+batch, len(needs))]
		args := make([]any, len(chunk))
		byRID := map[int64][]need{}
		for j, n := range chunk {
			args[j] = n.rid
			byRID[n.rid] = append(byRID[n.rid], n)
		}
		q := `SELECT rowid, body FROM msg_fts WHERE rowid IN (` + strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",") + `)`
		brows, err := db.Query(q, args...)
		if err != nil {
			return 0, err
		}
		for brows.Next() {
			var rid int64
			var body string
			if brows.Scan(&rid, &body) != nil {
				continue
			}
			for _, n := range byRID[rid] {
				for _, name := range extractNames(body, n.target, knownFirst) {
					a := get(n.target)
					key := strings.ToLower(name)
					h := a.names[key]
					if h == nil {
						where := "#" + s.dir.ChannelName(n.ch)
						if c := s.dir.channels[n.ch]; c != nil && c.Kind == "im" {
							where = "DM"
						} else if c != nil && c.Kind == "mpim" {
							where = "group DM"
						}
						h = &nameHit{example: fmt.Sprintf("%s %s: “%s”", where, time.UnixMicro(n.id).Format("2006-01-02"), snippet(body))}
						a.names[key] = h
					}
					h.count++
					a.total++
				}
			}
		}
		brows.Close()
	}

	day := func(id int64) string { return time.UnixMicro(id).Format("2006-01-02") }
	out := map[string]aliases.Entry{}
	for id, a := range accts {
		if !isUnknown(id) || a.msgs == 0 {
			continue
		}
		e := aliases.Entry{Messages: a.msgs, FirstSeen: day(a.first), LastSeen: day(a.last)}
		// best name
		type nc struct {
			name string
			h    *nameHit
		}
		var names []nc
		for n, h := range a.names {
			names = append(names, nc{n, h})
		}
		sort.Slice(names, func(i, j int) bool { return names[i].h.count > names[j].h.count })
		if len(names) == 0 {
			continue // no evidence → no suggestion
		}
		top := names[0]
		// require a minimum and a clear plurality
		if top.h.count < 2 && a.total > 1 {
			continue
		}
		share := float64(top.h.count) / float64(a.total)
		if share < 0.4 {
			continue
		}
		nameStrength := share * math.Min(1, float64(top.h.count)/4)
		display := strings.ToUpper(top.name[:1]) + top.name[1:]
		e.Evidence = append(e.Evidence, fmt.Sprintf("addressed as “%s” %d× (e.g. %s)", display, top.h.count, top.h.example))
		if len(names) > 1 {
			var others []string
			for _, o := range names[1:min(4, len(names))] {
				others = append(others, fmt.Sprintf("%s ×%d", strings.ToUpper(o.name[:1])+o.name[1:], o.h.count))
			}
			e.Evidence = append(e.Evidence, "other names seen: "+strings.Join(others, ", "))
		}
		cands := byFirst[top.name]
		if len(cands) == 0 {
			if top.h.count < 2 {
				continue // a single sighting isn't enough for a name-only guess
			}
			e.Name = display
			e.Confidence = round2(0.5 * nameStrength)
			e.Evidence = append(e.Evidence, "no current user named "+display+"; suggesting the name only")
			out[id] = e
			continue
		}
		type scored struct {
			u       *archive.User
			overlap float64
			shared  int
			last    int64
			score   float64
		}
		var sc []scored
		for _, u := range cands {
			ua := accts[u.ID]
			var shared int
			var union int
			var last int64
			if ua != nil {
				last = ua.last
				for ch := range a.channels {
					if ua.channels[ch] > 0 {
						shared++
					}
				}
				union = len(a.channels) + len(ua.channels) - shared
			}
			ov := 0.0
			if union > 0 {
				ov = float64(shared) / float64(len(a.channels))
			}
			x := scored{u: u, overlap: ov, shared: shared, last: last}
			x.score = ov
			if u.Deleted {
				x.score -= 0.05
			}
			sc = append(sc, x)
		}
		sort.Slice(sc, func(i, j int) bool {
			if math.Abs(sc[i].score-sc[j].score) > 0.05 {
				return sc[i].score > sc[j].score
			}
			return sc[i].last > sc[j].last // prefer most recently active
		})
		best := sc[0]
		e.MapsTo = best.u.ID
		cont := 0.5
		if best.last > a.last {
			cont = 1
			e.Evidence = append(e.Evidence, fmt.Sprintf("%s is active until %s (this account last posted %s)", best.u.Name, day(best.last), day(a.last)))
		}
		if best.shared > 0 {
			e.Evidence = append(e.Evidence, fmt.Sprintf("shares %d of this account's %d conversations with %s", best.shared, len(a.channels), best.u.Name))
		}
		if len(sc) > 1 {
			var alts []string
			for _, o := range sc[1:min(4, len(sc))] {
				alts = append(alts, fmt.Sprintf("%s (%s, %d shared)", o.u.RealName, o.u.ID, o.shared))
			}
			e.Evidence = append(e.Evidence, "other people with this first name: "+strings.Join(alts, "; "))
		}
		conf := 0.6*nameStrength + 0.3*math.Min(1, best.overlap*2) + 0.1*cont
		if len(sc) > 1 && math.Abs(sc[0].score-sc[1].score) < 0.05 {
			conf *= 0.8 // ambiguous between same-name people
		}
		e.Confidence = round2(math.Min(conf, 0.97))
		out[id] = e
	}
	if err := s.aliases.Merge(out); err != nil {
		return 0, err
	}
	return len(out), nil
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }
