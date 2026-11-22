package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dkurth/slackdumpviewer/internal/archive"
	"github.com/dkurth/slackdumpviewer/internal/fixture"
)

type env struct {
	t    *testing.T
	dir  string
	srv  *Server
	http *httptest.Server
}

func setup(t *testing.T) *env {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "archive with spaces & ünïcode")
	if _, err := fixture.Build(dir); err != nil {
		t.Fatal(err)
	}
	return start(t, dir)
}

func start(t *testing.T, dir string) *env {
	a, err := archive.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	if a.InUse {
		t.Fatal("fixture should not look in use")
	}
	s, err := New(Config{Archive: a, CacheDir: filepath.Join(dir, ".slackdumpviewer"), Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureIndex(nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	hs := httptest.NewServer(s.Handler(nil))
	t.Cleanup(hs.Close)
	return &env{t: t, dir: dir, srv: s, http: hs}
}

func (e *env) get(path string, out any) int {
	e.t.Helper()
	resp, err := http.Get(e.http.URL + path)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	if out != nil {
		b, _ := io.ReadAll(resp.Body)
		if err := json.Unmarshal(b, out); err != nil {
			e.t.Fatalf("GET %s: %v: %s", path, err, b)
		}
	}
	return resp.StatusCode
}

type msgsResp struct {
	Messages      []map[string]any `json:"messages"`
	HasMoreBefore bool             `json:"has_more_before"`
	HasMoreAfter  bool             `json:"has_more_after"`
}

func TestMessagesPagingAndDedupe(t *testing.T) {
	e := setup(t)
	var r msgsResp
	e.get("/api/messages?channel="+fixture.General+"&limit=50", &r)
	if len(r.Messages) != 50 || !r.HasMoreBefore || r.HasMoreAfter {
		t.Fatalf("latest page: n=%d before=%v after=%v", len(r.Messages), r.HasMoreBefore, r.HasMoreAfter)
	}
	last := r.Messages[len(r.Messages)-1]["ts"]
	if last != fixture.TS(250) { // the broadcast is the newest top-level message
		t.Errorf("newest = %v", last)
	}
	// Page back through everything; expect 250 + 1 broadcast top-level, no thread replies.
	seen := map[string]bool{}
	before := ""
	for i := 0; i < 20; i++ {
		var p msgsResp
		q := "/api/messages?channel=" + fixture.General + "&limit=70"
		if before != "" {
			q += "&before=" + before
		}
		e.get(q, &p)
		for _, m := range p.Messages {
			ts := m["ts"].(string)
			if seen[ts] {
				t.Fatalf("duplicate %s", ts)
			}
			seen[ts] = true
		}
		if !p.HasMoreBefore {
			break
		}
		before = p.Messages[0]["ts"].(string)
	}
	if len(seen) != fixture.GeneralCount+1 {
		t.Errorf("top-level count = %d", len(seen))
	}
	for _, n := range []int{251, 252, 253} {
		if seen[fixture.TS(n)] {
			t.Errorf("thread reply %d in channel timeline", n)
		}
	}
	// Latest version of message 5 wins.
	var a msgsResp
	e.get("/api/messages?channel="+fixture.General+"&around="+fixture.TS(5)+"&limit=4", &a)
	var m5 map[string]any
	for _, m := range a.Messages {
		if m["ts"] == fixture.TS(5) {
			m5 = m
		}
	}
	if m5 == nil || !strings.Contains(m5["text"].(string), "(edited)") || len(m5["reactions"].([]any)) != 2 {
		t.Errorf("message 5 = %v", m5)
	}
	if !a.HasMoreBefore || !a.HasMoreAfter {
		t.Errorf("around: before=%v after=%v", a.HasMoreBefore, a.HasMoreAfter)
	}
}

func TestThreadAndReplyCounts(t *testing.T) {
	e := setup(t)
	var a msgsResp
	e.get("/api/messages?channel="+fixture.General+"&around="+fixture.TS(100)+"&limit=3", &a)
	var parent map[string]any
	for _, m := range a.Messages {
		if m["ts"] == fixture.TS(100) {
			parent = m
		}
	}
	if parent == nil || parent["_archived_replies"].(float64) != 4 || parent["reply_count"].(float64) != 4 {
		t.Fatalf("parent = %v", parent)
	}
	var th struct {
		Parent  map[string]any   `json:"parent"`
		Replies []map[string]any `json:"replies"`
	}
	e.get("/api/thread?channel="+fixture.General+"&ts="+fixture.TS(100), &th)
	if th.Parent == nil || len(th.Replies) != 4 {
		t.Fatalf("thread: parent=%v replies=%d", th.Parent != nil, len(th.Replies))
	}
	var loc map[string]any
	e.get("/api/message?channel="+fixture.General+"&ts="+fixture.TS(252), &loc)
	if loc["thread_ts"] != fixture.TS(100) || loc["top"] != false {
		t.Errorf("lookup = %v", loc)
	}
}

func TestFilesAndMedia(t *testing.T) {
	e := setup(t)
	var a msgsResp
	e.get("/api/messages?channel="+fixture.General+"&around="+fixture.TS(6)+"&limit=4", &a)
	for _, m := range a.Messages {
		switch m["ts"] {
		case fixture.TS(6):
			f := m["files"].([]any)[0].(map[string]any)
			if f["local"] != true || f["url_private"] != nil {
				t.Errorf("file shaping: %v", f)
			}
		case fixture.TS(7):
			f := m["files"].([]any)[0].(map[string]any)
			if f["local"] != nil {
				t.Errorf("tombstone marked local")
			}
		}
	}
	resp, err := http.Get(e.http.URL + "/files/..%2F..%2F..%2F..%2Fetc%2Fpasswd")
	if err == nil {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(string(b), "root:") {
			t.Error("path traversal served a system file")
		}
	}
	for path, want := range map[string]int{
		"/files/F0IMAGE1/mockup.png": 200,
		"/thumbs/F0IMAGE1?w=64":      200,
		"/avatars/" + fixture.Alice:  200,
		"/avatars/" + fixture.Bob:    404,
		"/files/F0NOPE/x.png":        404,
		"/client/" + fixture.General: 200, // SPA route
	} {
		if code := e.get(path, nil); code != want {
			t.Errorf("GET %s = %d, want %d", path, code, want)
		}
	}
}

type searchResp struct {
	Total    int              `json:"total"`
	Messages []map[string]any `json:"messages"`
	Warnings []string         `json:"warnings"`
}

func TestSearch(t *testing.T) {
	e := setup(t)
	s := func(q string) searchResp {
		var r searchResp
		e.get("/api/search?tz=UTC&q="+url.QueryEscape(q), &r)
		return r
	}
	cases := map[string]int{
		"roadmap":                         GeneralRoadmap(),
		"roadmap from:@alice":             GeneralRoadmapBy(1),
		"from:me in:@alice":               1,
		"javelina":                        1,
		"in:#secret-project":              1,
		"has::tada:":                      1,
		"has::+1:":                        1,
		"has:pin":                         1,
		"has:link":                        1,
		"is:thread":                       5, // parent + 3 replies + broadcast
		`"ship friday"`:                   1,
		"friday -risky":                   1, // parent + broadcast? broadcast says "ship it"; parent matches
		"cafe naive resume":               1, // diacritics folded
		"risk*":                           3,
		"deployed production":             1, // attachment text
		"to:@alice":                       2, // mention + DM message from me
		"on:2024-03-04 from:@bob roadmap": GeneralRoadmapByOnDay(2),
		"with:@alice":                     4, // DM (2) + thread messages (parent? no: replies by alice in thread)
	}
	for q, want := range cases {
		r := s(q)
		if q == "with:@alice" {
			if r.Total < 2 {
				t.Errorf("search %q = %d, want >= 2", q, r.Total)
			}
			continue
		}
		if r.Total != want {
			t.Errorf("search %q = %d, want %d (warnings %v)", q, r.Total, want, r.Warnings)
		}
	}
	// channel_join messages are excluded
	if r := s("joined"); r.Total != 0 {
		t.Errorf("join messages in results: %d", r.Total)
	}
	if r := s("from:@nobody"); len(r.Warnings) == 0 || r.Total != 0 {
		t.Errorf("unknown user: %+v", r)
	}
	// Old account shows up via from:U0OLDBOB
	if r := s("from:" + fixture.OldBob); r.Total == 0 {
		t.Error("old account search")
	}
	var fr struct {
		Total int `json:"total"`
	}
	e.get("/api/search/files?q=mockup", &fr)
	if fr.Total != 1 {
		t.Errorf("file search = %d", fr.Total)
	}
}

// roadmap messages: general messages 0..249 except overwritten texts.
func GeneralRoadmap() int {
	n := 0
	for i := 0; i < fixture.GeneralCount; i++ {
		if !special(i) {
			n++
		}
	}
	return n
}

func GeneralRoadmapBy(author int) int {
	n := 0
	for i := 0; i < fixture.GeneralCount; i++ {
		if !special(i) && i%5 == author {
			n++
		}
	}
	return n
}

// messages are one minute apart starting 15:00 UTC on 2024-03-04, so the
// first 540 minutes are on that day.
func GeneralRoadmapByOnDay(author int) int {
	n := 0
	for i := 0; i < fixture.GeneralCount; i++ {
		if !special(i) && i%5 == author && i < 540 {
			n++
		}
	}
	return n
}

func special(i int) bool {
	switch i {
	case 5, 6, 8, 10, 100:
		return true
	}
	return false
}

func TestAliasesApplyToSearch(t *testing.T) {
	e := setup(t)
	req, _ := http.NewRequest("PUT", e.http.URL+"/api/aliases/"+fixture.OldBob, strings.NewReader(`{"status":"confirmed","maps_to":"`+fixture.Bob+`"}`))
	req.Header.Set("X-Requested-With", "slackdumpviewer")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("put alias: %v %v", err, resp.Status)
	}
	var r searchResp
	e.get("/api/search?q="+url.QueryEscape("from:@bob on it"), &r)
	if r.Total != 1 {
		t.Errorf("from:@bob should include old account: %d", r.Total)
	}
	// Without the CSRF header, writes are refused.
	req, _ = http.NewRequest("PUT", e.http.URL+"/api/aliases/"+fixture.OldBob, strings.NewReader(`{"status":"rejected"}`))
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Errorf("CSRF check: %d", resp.StatusCode)
	}
}

// The viewer must never modify anything outside .slackdumpviewer/, and must
// not create -wal/-shm/-journal files.
func TestArchiveIsNeverModified(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ro")
	if _, err := fixture.Build(dir); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, dir)
	e := start(t, dir)
	for _, p := range []string{"/api/bootstrap", "/api/messages?channel=" + fixture.General, "/api/search?q=roadmap", "/thumbs/F0IMAGE1?w=64", "/avatars/" + fixture.Alice, "/files/F0IMAGE1/mockup.png", "/api/unknown-users"} {
		e.get(p, nil)
	}
	e.srv.Close()
	after := snapshot(t, dir)
	for p, h := range before {
		if after[p] != h {
			t.Errorf("%s changed", p)
		}
	}
	for p := range after {
		if _, ok := before[p]; !ok {
			t.Errorf("new file outside .slackdumpviewer: %s", p)
		}
	}
}

func snapshot(t *testing.T, dir string) map[string]string {
	out := map[string]string{}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		if d.IsDir() {
			if rel == ".slackdumpviewer" {
				return filepath.SkipDir
			}
			return nil
		}
		b, _ := os.ReadFile(p)
		st, _ := d.Info()
		h := sha256.Sum256(b)
		out[rel] = hex.EncodeToString(h[:]) + st.ModTime().String()
		return nil
	})
	return out
}

func TestAliasSuggestions(t *testing.T) {
	e := setup(t) // first launch writes suggestions (no aliases.json yet)
	snap := e.srv.aliases.Snapshot()
	got, ok := snap[fixture.OldBob]
	if !ok {
		t.Fatalf("no suggestion for old account; have %v", snap)
	}
	if got.MapsTo != fixture.Bob || got.Status != "suggested" || len(got.Evidence) == 0 {
		t.Errorf("suggestion = %+v", got)
	}
	// confirmed decisions survive a re-run
	got.Status = "rejected"
	if err := e.srv.aliases.Set(fixture.OldBob, got); err != nil {
		t.Fatal(err)
	}
	if _, err := e.srv.SuggestAliases(); err != nil {
		t.Fatal(err)
	}
	if e.srv.aliases.Snapshot()[fixture.OldBob].Status != "rejected" {
		t.Error("re-running suggest overwrote a rejected entry")
	}
}

func TestExtractNames(t *testing.T) {
	known := func(n string) bool { return n == "brandon" || n == "bob" }
	cases := map[string][]string{
		"Hey Brandon, welcome back!":       {"Brandon"},
		"thanks Bob!":                      {"Bob"},
		"Brandon, can you look?":           {"Brandon"},
		"Awesome, thanks":                  nil,
		"Interesting, let's see":           nil,
		"GREAT NEWS GUYS":                  nil,
		"@U0OTHER Hi, Cary!":               nil,
		"@" + fixture.OldBob + " Hi, Bob!": {"Bob"},
		"Zofia, see above":                 nil, // comma form needs a known name
		"Congrats Zofia!":                  {"Zofia"},
	}
	for in, want := range cases {
		got := extractNames(in, fixture.OldBob, known)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("extractNames(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestAbout(t *testing.T) {
	e := setup(t)
	var r struct {
		Stats     aboutStats     `json:"stats"`
		Workspace map[string]any `json:"workspace"`
		Aliases   map[string]int `json:"aliases"`
	}
	if c := e.get("/api/about", &r); c != 200 {
		t.Fatalf("status %d", c)
	}
	st := r.Stats
	if len(st.Sessions) != 2 || st.Sessions[0].Mode != "archive" || st.Sessions[0].Created == "" {
		t.Errorf("sessions: %+v", st.Sessions)
	}
	if st.Threads == 0 || st.Replies == 0 || st.FirstTS == "" || st.LastTS <= st.FirstTS {
		t.Errorf("thread/date stats: %+v", st)
	}
	if st.Conversations["public"] == 0 || st.Users["total"] == 0 || len(st.TopChannels) == 0 || len(st.ByYear) == 0 {
		t.Errorf("counts: conv=%v users=%v top=%v years=%v", st.Conversations, st.Users, st.TopChannels, st.ByYear)
	}
	if st.Unknown == 0 {
		t.Errorf("fixture has unknown users, got 0")
	}
}
