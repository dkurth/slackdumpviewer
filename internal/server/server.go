// Package server serves the viewer's JSON API, media and the embedded SPA.
package server

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dkurth/slackdumpviewer/internal/aliases"
	"github.com/dkurth/slackdumpviewer/internal/archive"
	"github.com/dkurth/slackdumpviewer/internal/index"
)

//go:embed all:dist
var distFS embed.FS

type Config struct {
	Archive  *archive.Archive
	CacheDir string // .slackdumpviewer directory
	Reindex  bool
	Logf     func(format string, args ...any)
}

type Server struct {
	cfg       Config
	a         *archive.Archive
	ws        archive.Workspace
	dir       *Directory
	aliases   *aliases.Store
	ix        atomic.Pointer[index.Index]
	progress  atomic.Pointer[index.Progress]
	indexErr  atomic.Pointer[string]
	thumbs    *thumbnailer
	emoji     map[string]string // custom emoji name -> file path or "alias:x"
	startedAt time.Time
	about     aboutCache
	mu        sync.Mutex
}

func New(cfg Config) (*Server, error) {
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	s := &Server{cfg: cfg, a: cfg.Archive, startedAt: time.Now()}
	ws, err := s.a.Workspace()
	if err != nil {
		return nil, err
	}
	s.ws = ws
	if err := os.MkdirAll(cfg.CacheDir, 0o755); err != nil {
		return nil, err
	}
	al, err := aliases.Load(filepath.Join(cfg.CacheDir, "aliases.json"))
	if err != nil {
		return nil, err
	}
	s.aliases = al
	users, err := s.a.Users(ws.TeamID)
	if err != nil {
		return nil, err
	}
	chans, err := s.a.Channels()
	if err != nil {
		return nil, err
	}
	s.dir = NewDirectory(ws.UserID, users, chans, al)
	s.thumbs = newThumbnailer(filepath.Join(cfg.CacheDir, "thumbs"))
	s.emoji = loadCustomEmoji(s.a.EmojiDir)
	return s, nil
}

// IndexPath is where the index lives.
func (s *Server) IndexPath() string { return filepath.Join(s.cfg.CacheDir, "index.sqlite") }

// EnsureIndex opens the index, building it first if needed. It blocks; call
// it in a goroutine to serve the UI while indexing.
func (s *Server) EnsureIndex(onProgress func(index.Progress)) error {
	p := s.IndexPath()
	if s.cfg.Reindex || !index.Fresh(p, s.a) {
		s.cfg.Logf("Building search index (first run or archive changed)…")
		err := index.Build(p, s.a, s.dir, func(pr index.Progress) {
			s.progress.Store(&pr)
			if onProgress != nil {
				onProgress(pr)
			}
		})
		if err != nil {
			msg := err.Error()
			s.indexErr.Store(&msg)
			return err
		}
	}
	ix, err := index.Open(p)
	if err != nil {
		msg := err.Error()
		s.indexErr.Store(&msg)
		return err
	}
	if err := s.dir.LoadStats(ix.DB); err != nil {
		return err
	}
	if !s.aliases.Exists() {
		if pr := (index.Progress{Phase: "Suggesting aliases"}); onProgress != nil {
			onProgress(pr)
		}
		if n, err := s.suggestWith(ix.DB); err != nil {
			s.cfg.Logf("alias suggestions failed: %v", err)
		} else {
			s.cfg.Logf("Wrote %d alias suggestions to %s", n, s.aliases.Path())
		}
	}
	s.ix.Store(ix)
	return nil
}

func (s *Server) Close() {
	if ix := s.ix.Load(); ix != nil {
		ix.Close()
	}
}

// Handler returns the HTTP handler. allowedHosts are accepted Host headers
// (DNS-rebinding protection).
func (s *Server) Handler(allowedHosts []string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("GET /api/bootstrap", s.needIndex(s.handleBootstrap))
	mux.HandleFunc("GET /api/messages", s.needIndex(s.handleMessages))
	mux.HandleFunc("GET /api/thread", s.needIndex(s.handleThread))
	mux.HandleFunc("GET /api/conversation", s.needIndex(s.handleConversation))
	mux.HandleFunc("GET /api/conversation/files", s.needIndex(s.handleConversationFiles))
	mux.HandleFunc("GET /api/search", s.needIndex(s.handleSearch))
	mux.HandleFunc("GET /api/search/files", s.needIndex(s.handleSearchFiles))
	mux.HandleFunc("GET /api/message", s.needIndex(s.handleMessageLookup))
	mux.HandleFunc("GET /api/unknown-users", s.needIndex(s.handleUnknownUsers))
	mux.HandleFunc("GET /api/about", s.needIndex(s.handleAbout))
	mux.HandleFunc("GET /api/aliases", s.handleAliasesGet)
	mux.HandleFunc("PUT /api/aliases/{id}", s.handleAliasPut)
	mux.HandleFunc("GET /files/{id}/{name...}", s.handleFile)
	mux.HandleFunc("GET /thumbs/{id}", s.handleThumb)
	mux.HandleFunc("GET /avatars/{id}", s.handleAvatar)
	mux.HandleFunc("GET /emoji/{name}", s.handleEmoji)
	mux.HandleFunc("GET /", s.handleSPA)

	hosts := map[string]bool{}
	for _, h := range allowedHosts {
		hosts[strings.ToLower(h)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(hosts) > 0 && !hosts[strings.ToLower(r.Host)] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			// CSRF: only same-origin JS can write.
			if r.Header.Get("X-Requested-With") != "slackdumpviewer" {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

// AllowedHosts builds the Host header allowlist for a listener address.
func AllowedHosts(addr net.Addr) []string {
	_, port, _ := net.SplitHostPort(addr.String())
	return []string{"127.0.0.1:" + port, "localhost:" + port, "[::1]:" + port}
}

func (s *Server) needIndex(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.ix.Load() == nil {
			writeJSON(w, http.StatusServiceUnavailable, s.status())
			return
		}
		h(w, r)
	}
}

type statusResp struct {
	Ready    bool            `json:"ready"`
	Progress *index.Progress `json:"progress,omitempty"`
	Error    string          `json:"error,omitempty"`
	InUse    bool            `json:"in_use"`
}

func (s *Server) status() statusResp {
	st := statusResp{Ready: s.ix.Load() != nil, Progress: s.progress.Load(), InUse: s.a.InUse}
	if e := s.indexErr.Load(); e != nil {
		st.Error = *e
	}
	return st
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.status())
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// ---- SPA ----

func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	sub, _ := fs.Sub(distFS, "dist")
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" {
		p = "index.html"
	}
	if st, err := fs.Stat(sub, p); err == nil && !st.IsDir() {
		if strings.HasPrefix(p, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		http.ServeFileFS(w, r, sub, p)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeErr(w, 404, "not found")
		return
	}
	// Client-side route: serve index.html.
	b, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		http.Error(w, "frontend not built (run make build)", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(b)
}
