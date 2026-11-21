package server

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/dkurth/slackdumpviewer/internal/archive"
)

func ts(id int64) string { return fmt.Sprintf("%d.%06d", id/1_000_000, id%1_000_000) }

// parseTS converts "1691774440.143419" (or a microsecond integer) to an id.
func parseTS(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	if strings.HasPrefix(s, "p") { // permalink form p1691774440143419
		s = s[1:]
	}
	sec, frac, found := strings.Cut(s, ".")
	if !found {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			return 0, false
		}
		if v < 1e11 { // plain seconds
			return v * 1_000_000, true
		}
		return v, true
	}
	if len(frac) > 6 {
		frac = frac[:6]
	}
	frac += strings.Repeat("0", 6-len(frac))
	a, err1 := strconv.ParseInt(sec, 10, 64)
	b, err2 := strconv.ParseInt(frac, 10, 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return a*1_000_000 + b, true
}

// file fields passed to the client; everything else (Slack-auth URLs,
// thumbnail URLs, share info) is dropped.
var keepFileFields = map[string]bool{
	"id": true, "name": true, "title": true, "mimetype": true, "filetype": true, "pretty_type": true,
	"mode": true, "size": true, "original_w": true, "original_h": true, "created": true, "user": true,
	"preview": true, "preview_highlight": false, "lines": true, "lines_more": true, "is_external": true,
	"external_type": true, "image_exif_rotation": true, "thumb_360_w": true, "thumb_360_h": true,
	"thumb_480_w": true, "thumb_480_h": true, "thumb_video_w": true, "thumb_video_h": true, "duration_ms": true,
	"subject": true, "from": true, "to": true, "cc": true, "plain_text": true,
}

var dropMsgFields = []string{"replace_original", "delete_original", "metadata", "client_msg_id", "team", "user_team", "source_team", "blocks_meta"}

// shapeMessage trims a raw Slack message for the client.
func (s *Server) shapeMessage(raw []byte, channel string) map[string]any {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return map[string]any{"ts": "", "text": "(unreadable message)", "_ch": channel}
	}
	for _, k := range dropMsgFields {
		delete(m, k)
	}
	if files, ok := m["files"].([]any); ok {
		for i, f := range files {
			fm, ok := f.(map[string]any)
			if !ok {
				continue
			}
			out := map[string]any{}
			for k, v := range fm {
				if keepFileFields[k] {
					out[k] = v
				}
			}
			mode, _ := fm["mode"].(string)
			if mode == "external" {
				// links to Google Docs etc. (not Slack-authenticated)
				if u, ok := fm["url_private"].(string); ok && !strings.Contains(u, "files.slack.com") {
					out["external_url"] = u
				}
			}
			id, _ := fm["id"].(string)
			name, _ := fm["name"].(string)
			if id != "" && mode != "tombstone" && mode != "external" {
				if p, ok := s.a.UploadPath(id, name); ok {
					out["local"] = true
					out["local_name"] = baseName(p)
				}
			}
			files[i] = out
		}
	}
	// user_profile embedded in some messages: keep only the name fields.
	if up, ok := m["user_profile"].(map[string]any); ok {
		m["user_profile"] = map[string]any{
			"real_name": up["real_name"], "display_name": up["display_name"], "name": up["name"],
		}
	}
	if bp, ok := m["bot_profile"].(map[string]any); ok {
		m["bot_profile"] = map[string]any{"name": bp["name"], "id": bp["id"], "app_id": bp["app_id"]}
	}
	delete(m, "icons") // remote URLs
	m["_ch"] = channel
	return m
}

func baseName(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

type msgRow struct {
	Channel string
	ID      int64
	Chunk   int64
	Parent  int64
}

// loadMessages fetches and shapes messages, preserving order.
func (s *Server) loadMessages(rows []msgRow) ([]map[string]any, error) {
	keys := make([]archive.MessageKey, len(rows))
	for i, r := range rows {
		keys[i] = archive.MessageKey{ID: r.ID, Chunk: r.Chunk}
	}
	data, err := s.a.MessageData(keys)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		raw, ok := data[archive.MessageKey{ID: r.ID, Chunk: r.Chunk}]
		if !ok {
			continue
		}
		m := s.shapeMessage(raw, r.Channel)
		if r.Parent != 0 {
			m["_parent"] = ts(r.Parent)
		}
		out = append(out, m)
	}
	return out, nil
}
