// Package aliases maps old (pre-merge) user IDs that have no profile in the
// archive to current users or to plain names. Stored in
// <archive>/.slackdumpviewer/aliases.json, which the user may edit.
package aliases

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

const (
	Suggested = "suggested"
	Confirmed = "confirmed"
	Rejected  = "rejected"
)

type Entry struct {
	Status     string   `json:"status"`
	MapsTo     string   `json:"maps_to,omitempty"`
	Name       string   `json:"name,omitempty"`
	Confidence float64  `json:"confidence,omitempty"`
	Evidence   []string `json:"evidence,omitempty"`
	// Stats, informational only (filled by suggest).
	Messages  int    `json:"messages,omitempty"`
	FirstSeen string `json:"first_seen,omitempty"`
	LastSeen  string `json:"last_seen,omitempty"`
}

type File struct {
	Version int               `json:"version"`
	Note    string            `json:"note"`
	Aliases map[string]*Entry `json:"aliases"`
}

const note = `Maps user IDs that have no profile in the archive (mostly old accounts from before the workspace merge) to current users ("maps_to") or to plain names ("name"). Only entries with "status": "confirmed" are applied by default; set status to "confirmed" or "rejected" to review a suggestion. Re-running "slackdumpviewer aliases suggest" refreshes suggestions but never changes confirmed or rejected entries.`

type Store struct {
	mu   sync.RWMutex
	path string
	f    File
}

func Load(path string) (*Store, error) {
	s := &Store{path: path, f: File{Version: 1, Note: note, Aliases: map[string]*Entry{}}}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.f); err != nil {
		return nil, err
	}
	if s.f.Aliases == nil {
		s.f.Aliases = map[string]*Entry{}
	}
	s.f.Note = note
	return s, nil
}

func (s *Store) Path() string { return s.path }

func (s *Store) Exists() bool {
	_, err := os.Stat(s.path)
	return err == nil
}

// Snapshot returns a copy of all entries.
func (s *Store) Snapshot() map[string]Entry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]Entry, len(s.f.Aliases))
	for k, v := range s.f.Aliases {
		out[k] = *v
	}
	return out
}

// Set replaces one entry and saves.
func (s *Store) Set(id string, e Entry) error {
	s.mu.Lock()
	s.f.Aliases[id] = &e
	s.mu.Unlock()
	return s.Save()
}

// Merge applies suggestions, keeping confirmed/rejected entries untouched.
func (s *Store) Merge(sugg map[string]Entry) error {
	s.mu.Lock()
	for id, e := range sugg {
		if cur, ok := s.f.Aliases[id]; ok && (cur.Status == Confirmed || cur.Status == Rejected) {
			// keep the user's decision, refresh stats only
			cur.Messages, cur.FirstSeen, cur.LastSeen = e.Messages, e.FirstSeen, e.LastSeen
			continue
		}
		e := e
		e.Status = Suggested
		s.f.Aliases[id] = &e
	}
	s.mu.Unlock()
	return s.Save()
}

// Save writes atomically, with sorted keys and indentation for hand editing.
func (s *Store) Save() error {
	s.mu.RLock()
	b, err := json.MarshalIndent(s.f, "", "  ")
	s.mu.RUnlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Groups returns, for every user ID involved in an applied alias, the full set
// of IDs that refer to the same person. includeSuggested also applies
// suggestions.
func (s *Store) Groups(includeSuggested bool) map[string][]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	parent := map[string]string{}
	var find func(string) string
	find = func(x string) string {
		if p, ok := parent[x]; ok && p != x {
			r := find(p)
			parent[x] = r
			return r
		}
		parent[x] = x
		return x
	}
	union := func(a, b string) { parent[find(a)] = find(b) }
	for id, e := range s.f.Aliases {
		if !applies(e, includeSuggested) || e.MapsTo == "" {
			continue
		}
		union(id, e.MapsTo)
	}
	members := map[string][]string{}
	for id := range parent {
		r := find(id)
		members[r] = append(members[r], id)
	}
	out := map[string][]string{}
	for _, ms := range members {
		sort.Strings(ms)
		for _, id := range ms {
			out[id] = ms
		}
	}
	return out
}

func applies(e *Entry, includeSuggested bool) bool {
	return e.Status == Confirmed || (includeSuggested && e.Status == Suggested)
}
