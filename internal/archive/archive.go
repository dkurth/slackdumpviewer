// Package archive reads a slackdump "archive" directory (slackdump.sqlite +
// __uploads, optional __avatars and emojis). It never writes to it.
package archive

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

// Archive is an open, read-only slackdump archive.
type Archive struct {
	Dir      string // archive directory
	DBPath   string // path to slackdump.sqlite
	DB       *sql.DB
	InUse    bool // a -wal file exists: slackdump may be running; opened mode=ro
	DBSize   int64
	DBMtime  int64 // unix nanos
	Uploads  string
	Avatars  string // "" if absent
	EmojiDir string // "" if absent
}

// Resolve accepts an archive directory or a path to slackdump.sqlite and
// returns (dir, dbPath).
func Resolve(p string) (string, string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", "", err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", "", err
	}
	if st.IsDir() {
		db := filepath.Join(abs, "slackdump.sqlite")
		if _, err := os.Stat(db); err != nil {
			return "", "", fmt.Errorf("%s does not look like a slackdump archive (no slackdump.sqlite)", abs)
		}
		return abs, db, nil
	}
	return filepath.Dir(abs), abs, nil
}

// SQLiteURI builds a file: URI for SQLite that works on macOS and Windows,
// with paths containing spaces, '#', '?' or non-ASCII characters.
func SQLiteURI(path string, params url.Values) string {
	p := filepath.ToSlash(path)
	if runtime.GOOS == "windows" || (len(p) > 1 && p[1] == ':') {
		if !strings.HasPrefix(p, "/") {
			p = "/" + p
		}
	}
	u := url.URL{Scheme: "file", Path: p, RawQuery: params.Encode()}
	// url.URL renders an empty host as "file:///..." which SQLite accepts.
	s := u.String()
	if !strings.HasPrefix(s, "file://") {
		s = "file://" + strings.TrimPrefix(s, "file:")
	}
	return s
}

// Open opens the archive read-only.
//
// slackdump.sqlite is in WAL mode, and slackdump removes the -wal/-shm files
// when it exits cleanly. A mode=ro connection cannot recreate -shm, so it
// fails with SQLITE_CANTOPEN. When no -wal exists (slackdump is not
// running), we open with immutable=1, which creates no files and takes no
// locks. When a -wal exists, we use mode=ro and flag InUse.
func Open(p string) (*Archive, error) {
	dir, dbPath, err := Resolve(p)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(dbPath)
	if err != nil {
		return nil, err
	}
	a := &Archive{Dir: dir, DBPath: dbPath, DBSize: st.Size(), DBMtime: st.ModTime().UnixNano()}
	params := url.Values{}
	if _, err := os.Stat(dbPath + "-wal"); err == nil {
		a.InUse = true
		params.Set("mode", "ro")
	} else {
		params.Set("immutable", "1")
	}
	db, err := sql.Open("sqlite", SQLiteURI(dbPath, params))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(runtime.NumCPU())
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open %s: %w", dbPath, err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('MESSAGE','CHUNK','CHANNEL','S_USER')`).Scan(&n); err != nil {
		db.Close()
		return nil, fmt.Errorf("read %s: %w", dbPath, err)
	}
	if n != 4 {
		db.Close()
		return nil, fmt.Errorf("%s is not a slackdump archive database", dbPath)
	}
	a.DB = db
	a.Uploads = filepath.Join(dir, "__uploads")
	if st, err := os.Stat(filepath.Join(dir, "__avatars")); err == nil && st.IsDir() {
		a.Avatars = filepath.Join(dir, "__avatars")
	}
	for _, name := range []string{"emojis", "__emojis", "emoji"} {
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil && st.IsDir() {
			a.EmojiDir = filepath.Join(dir, name)
			break
		}
	}
	return a, nil
}

func (a *Archive) Close() error { return a.DB.Close() }

// ---- Workspace ----

type Workspace struct {
	TeamID   string `json:"team_id"`
	Team     string `json:"team"`
	URL      string `json:"url"`
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

func (a *Archive) Workspace() (Workspace, error) {
	var w Workspace
	var user sql.NullString
	err := a.DB.QueryRow(`SELECT TEAM_ID, TEAM, URL, USER_ID, USERNAME FROM WORKSPACE ORDER BY CHUNK_ID DESC LIMIT 1`).
		Scan(&w.TeamID, &w.Team, &w.URL, &w.UserID, &user)
	w.Username = user.String
	if errors.Is(err, sql.ErrNoRows) {
		return w, nil
	}
	return w, err
}

// ---- Users ----

type User struct {
	ID          string `json:"id"`
	Name        string `json:"name"` // username handle
	RealName    string `json:"real_name,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	Title       string `json:"title,omitempty"`
	Color       string `json:"color,omitempty"`
	Email       string `json:"email,omitempty"`
	Phone       string `json:"phone,omitempty"`
	TZ          string `json:"tz,omitempty"`
	TZLabel     string `json:"tz_label,omitempty"`
	IsBot       bool   `json:"is_bot,omitempty"`
	IsApp       bool   `json:"is_app,omitempty"`
	Deleted     bool   `json:"deleted,omitempty"`
	IsAdmin     bool   `json:"is_admin,omitempty"`
	IsOwner     bool   `json:"is_owner,omitempty"`
	Restricted  bool   `json:"is_restricted,omitempty"`
	External    bool   `json:"external,omitempty"` // from another team (shared channel)
	TeamID      string `json:"team_id,omitempty"`
	AvatarHash  string `json:"avatar_hash,omitempty"`
	StatusText  string `json:"status_text,omitempty"`
	StatusEmoji string `json:"status_emoji,omitempty"`
	Updated     int64  `json:"updated,omitempty"`
}

type rawUser struct {
	ID       string `json:"id"`
	TeamID   string `json:"team_id"`
	Name     string `json:"name"`
	Deleted  bool   `json:"deleted"`
	Color    string `json:"color"`
	RealName string `json:"real_name"`
	TZ       string `json:"tz"`
	TZLabel  string `json:"tz_label"`
	IsBot    bool   `json:"is_bot"`
	IsApp    bool   `json:"is_app_user"`
	IsAdmin  bool   `json:"is_admin"`
	IsOwner  bool   `json:"is_owner"`
	Restrict bool   `json:"is_restricted"`
	Updated  int64  `json:"updated"`
	Profile  struct {
		RealName    string `json:"real_name"`
		DisplayName string `json:"display_name"`
		Title       string `json:"title"`
		Email       string `json:"email"`
		Phone       string `json:"phone"`
		AvatarHash  string `json:"avatar_hash"`
		StatusText  string `json:"status_text"`
		StatusEmoji string `json:"status_emoji"`
		Team        string `json:"team"`
	} `json:"profile"`
}

// Users returns the latest version of every user, keyed by ID.
func (a *Archive) Users(teamID string) (map[string]*User, error) {
	rows, err := a.DB.Query(`SELECT ID, DATA FROM S_USER ORDER BY CHUNK_ID`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*User{}
	for rows.Next() {
		var id string
		var data []byte
		if err := rows.Scan(&id, &data); err != nil {
			return nil, err
		}
		var r rawUser
		if err := json.Unmarshal(data, &r); err != nil {
			continue
		}
		u := &User{
			ID: id, Name: r.Name, RealName: firstNonEmpty(r.Profile.RealName, r.RealName),
			DisplayName: r.Profile.DisplayName, Title: r.Profile.Title, Color: r.Color,
			Email: r.Profile.Email, Phone: r.Profile.Phone, TZ: r.TZ, TZLabel: r.TZLabel,
			IsBot: r.IsBot, IsApp: r.IsApp, Deleted: r.Deleted, IsAdmin: r.IsAdmin, IsOwner: r.IsOwner,
			Restricted: r.Restrict, TeamID: r.TeamID, AvatarHash: r.Profile.AvatarHash,
			StatusText: r.Profile.StatusText, StatusEmoji: r.Profile.StatusEmoji, Updated: r.Updated,
		}
		if teamID != "" && r.TeamID != "" && r.TeamID != teamID {
			u.External = true
		}
		out[id] = u
	}
	return out, rows.Err()
}

// ---- Channels ----

type Channel struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Kind       string   `json:"kind"` // public | private | im | mpim
	IsArchived bool     `json:"is_archived,omitempty"`
	IsGeneral  bool     `json:"is_general,omitempty"`
	IsShared   bool     `json:"is_shared,omitempty"`
	IsMember   bool     `json:"is_member,omitempty"`
	Created    int64    `json:"created,omitempty"`
	Creator    string   `json:"creator,omitempty"`
	Topic      string   `json:"topic,omitempty"`
	Purpose    string   `json:"purpose,omitempty"`
	IMUser     string   `json:"im_user,omitempty"` // for DMs: the other person
	Members    []string `json:"members,omitempty"`
	NumMembers int      `json:"num_members,omitempty"`
}

type rawChannel struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Created    int64  `json:"created"`
	Creator    string `json:"creator"`
	IsIM       bool   `json:"is_im"`
	IsMPIM     bool   `json:"is_mpim"`
	IsPrivate  bool   `json:"is_private"`
	IsGroup    bool   `json:"is_group"`
	IsArchived bool   `json:"is_archived"`
	IsGeneral  bool   `json:"is_general"`
	IsShared   bool   `json:"is_shared"`
	IsExt      bool   `json:"is_ext_shared"`
	IsMember   bool   `json:"is_member"`
	User       string `json:"user"`
	NumMembers int    `json:"num_members"`
	Topic      struct {
		Value string `json:"value"`
	} `json:"topic"`
	Purpose struct {
		Value string `json:"value"`
	} `json:"purpose"`
}

// Channels returns the latest version of every conversation, keyed by ID.
func (a *Archive) Channels() (map[string]*Channel, error) {
	rows, err := a.DB.Query(`SELECT ID, NAME, DATA FROM CHANNEL ORDER BY CHUNK_ID`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*Channel{}
	for rows.Next() {
		var id string
		var name sql.NullString
		var data []byte
		if err := rows.Scan(&id, &name, &data); err != nil {
			return nil, err
		}
		var r rawChannel
		if err := json.Unmarshal(data, &r); err != nil {
			continue
		}
		c := &Channel{
			ID: id, Name: firstNonEmpty(r.Name, name.String), Created: r.Created, Creator: r.Creator,
			IsArchived: r.IsArchived, IsGeneral: r.IsGeneral, IsShared: r.IsShared || r.IsExt, IsMember: r.IsMember,
			Topic: r.Topic.Value, Purpose: r.Purpose.Value, NumMembers: r.NumMembers,
		}
		switch {
		case r.IsIM || strings.HasPrefix(id, "D"):
			c.Kind, c.IMUser = "im", r.User
		case r.IsMPIM:
			c.Kind = "mpim"
		case r.IsPrivate || r.IsGroup:
			c.Kind = "private"
		default:
			c.Kind = "public"
		}
		// Keep non-empty fields from earlier versions if a later one is sparse.
		if prev, ok := out[id]; ok {
			if c.Name == "" {
				c.Name = prev.Name
			}
			if c.IMUser == "" {
				c.IMUser = prev.IMUser
			}
		}
		out[id] = c
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := a.loadMembers(out); err != nil {
		return nil, err
	}
	return out, nil
}

// loadMembers fills Members from CHANNEL_USER, using the most recent session
// that recorded members for each channel.
func (a *Archive) loadMembers(chans map[string]*Channel) error {
	rows, err := a.DB.Query(`
		SELECT cu.CHANNEL_ID, cu.USER_ID, c.SESSION_ID
		FROM CHANNEL_USER cu JOIN CHUNK c ON c.ID = cu.CHUNK_ID
		ORDER BY cu.CHANNEL_ID, c.SESSION_ID, cu.CHUNK_ID, cu.IDX`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type acc struct {
		session int64
		users   []string
		seen    map[string]bool
	}
	m := map[string]*acc{}
	for rows.Next() {
		var ch, u string
		var sess int64
		if err := rows.Scan(&ch, &u, &sess); err != nil {
			return err
		}
		x := m[ch]
		if x == nil || sess > x.session {
			x = &acc{session: sess, seen: map[string]bool{}}
			m[ch] = x
		}
		if !x.seen[u] {
			x.seen[u] = true
			x.users = append(x.users, u)
		}
	}
	for id, x := range m {
		if c, ok := chans[id]; ok {
			c.Members = x.users
		}
	}
	return rows.Err()
}

// ---- Messages ----

// MessageKey identifies one stored version of a message.
type MessageKey struct {
	ID    int64
	Chunk int64
}

// MessageData fetches raw JSON for the given (ID, CHUNK_ID) keys.
func (a *Archive) MessageData(keys []MessageKey) (map[MessageKey][]byte, error) {
	out := make(map[MessageKey][]byte, len(keys))
	if len(keys) == 0 {
		return out, nil
	}
	// Row-value IN uses the (ID, CHUNK_ID) primary key index.
	var sb strings.Builder
	args := make([]any, 0, len(keys)*2)
	sb.WriteString(`SELECT ID, CHUNK_ID, DATA FROM MESSAGE WHERE (ID, CHUNK_ID) IN (VALUES `)
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString("(?,?)")
		args = append(args, k.ID, k.Chunk)
	}
	sb.WriteByte(')')
	rows, err := a.DB.Query(sb.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k MessageKey
		var data []byte
		if err := rows.Scan(&k.ID, &k.Chunk, &data); err != nil {
			return nil, err
		}
		out[k] = data
	}
	return out, rows.Err()
}

// ---- Files on disk ----

var fileIDRe = regexp.MustCompile(`^[A-Z0-9]{3,32}$`)

// ValidFileID reports whether id looks like a Slack file ID (safe as a path element).
func ValidFileID(id string) bool { return fileIDRe.MatchString(id) }

// UploadPath returns the on-disk path of an uploaded file. The file is found
// by listing __uploads/<id>/ rather than by building the name from JSON, so
// Unicode normalization differences (NFC vs NFD after copying between macOS
// and Windows) don't matter. If several files exist, prefer one whose name
// matches `want`.
func (a *Archive) UploadPath(id, want string) (string, bool) {
	if !ValidFileID(id) {
		return "", false
	}
	dir := filepath.Join(a.Uploads, id)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	var names []string
	for _, e := range ents {
		if e.Type().IsRegular() && !strings.HasPrefix(e.Name(), ".") {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return "", false
	}
	sort.Strings(names)
	pick := names[0]
	for _, n := range names {
		if n == want {
			pick = n
		}
	}
	return filepath.Join(dir, pick), true
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
