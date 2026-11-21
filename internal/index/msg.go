package index

import (
	"encoding/json"
	"html"
	"regexp"
	"strings"
)

// Msg is the subset of Slack message JSON the indexer needs.
type Msg struct {
	Type        string          `json:"type"`
	Subtype     string          `json:"subtype"`
	User        string          `json:"user"`
	BotID       string          `json:"bot_id"`
	Username    string          `json:"username"`
	Text        string          `json:"text"`
	TS          string          `json:"ts"`
	ThreadTS    string          `json:"thread_ts"`
	ReplyCount  int             `json:"reply_count"`
	Hidden      bool            `json:"hidden"`
	Edited      json.RawMessage `json:"edited"`
	PinnedTo    []string        `json:"pinned_to"`
	Files       []File          `json:"files"`
	Reactions   []Reaction      `json:"reactions"`
	Attachments []Attachment    `json:"attachments"`
	Blocks      json.RawMessage `json:"blocks"`
	BotProfile  *struct {
		Name string `json:"name"`
	} `json:"bot_profile"`
}

type File struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Mode     string `json:"mode"`
	Filetype string `json:"filetype"`
	Mimetype string `json:"mimetype"`
	Size     int64  `json:"size"`
	User     string `json:"user"`
	Preview  string `json:"preview"`
}

type Reaction struct {
	Name  string   `json:"name"`
	Count int      `json:"count"`
	Users []string `json:"users"`
}

type Attachment struct {
	Fallback   string `json:"fallback"`
	Pretext    string `json:"pretext"`
	Title      string `json:"title"`
	TitleLink  string `json:"title_link"`
	Text       string `json:"text"`
	Footer     string `json:"footer"`
	AuthorName string `json:"author_name"`
	FromURL    string `json:"from_url"`
	Fields     []struct {
		Title string `json:"title"`
		Value string `json:"value"`
	} `json:"fields"`
}

// Flags stored in msg.flags.
const (
	FlagFile     = 1 << iota // has (non-deleted) files
	FlagLink                 // contains a link
	FlagReaction             // has reactions
	FlagPinned               // pinned somewhere
	FlagReply                // thread reply (not the parent)
	FlagBot                  // bot / integration message
	FlagEdited               // edited
	FlagParent               // thread parent with replies
	FlagHidden               // hidden (e.g. tombstone)
)

var (
	reUserMention = regexp.MustCompile(`<@([UW][A-Z0-9]+)(?:\|([^>]*))?>`)
	reChanMention = regexp.MustCompile(`<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>`)
	reSpecial     = regexp.MustCompile(`<!(here|channel|everyone)(?:\|[^>]*)?>`)
	reSubteam     = regexp.MustCompile(`<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>`)
	reDate        = regexp.MustCompile(`<!date\^[^|>]*\|([^>]*)>`)
	reLink        = regexp.MustCompile(`<((?:https?|mailto|ftp):[^|>]+)(?:\|([^>]*))?>`)
	reBareLink    = regexp.MustCompile(`https?://`)
)

// Names resolves IDs to readable names for the search body.
type Names interface {
	UserName(id string) string
	ChannelName(id string) string
}

// PlainText converts Slack mrkdwn to searchable plain text: mentions become
// "@name", channel links "#name", links "label url".
func PlainText(s string, n Names) string {
	if s == "" {
		return ""
	}
	s = reUserMention.ReplaceAllStringFunc(s, func(m string) string {
		sm := reUserMention.FindStringSubmatch(m)
		if name := n.UserName(sm[1]); name != "" {
			return "@" + name
		}
		if sm[2] != "" {
			return "@" + sm[2]
		}
		return "@" + sm[1]
	})
	s = reChanMention.ReplaceAllStringFunc(s, func(m string) string {
		sm := reChanMention.FindStringSubmatch(m)
		if sm[2] != "" {
			return "#" + sm[2]
		}
		if name := n.ChannelName(sm[1]); name != "" {
			return "#" + name
		}
		return "#" + sm[1]
	})
	s = reSpecial.ReplaceAllString(s, "@$1")
	s = reSubteam.ReplaceAllString(s, "$1")
	s = reDate.ReplaceAllString(s, "$1")
	s = reLink.ReplaceAllStringFunc(s, func(m string) string {
		sm := reLink.FindStringSubmatch(m)
		u := strings.TrimPrefix(sm[1], "mailto:")
		if sm[2] != "" && sm[2] != u && sm[2] != sm[1] {
			return sm[2] + " " + u
		}
		return u
	})
	return html.UnescapeString(s)
}

// MentionedUsers returns user IDs mentioned with <@U…> in s.
func MentionedUsers(s string, into map[string]bool) {
	for _, m := range reUserMention.FindAllStringSubmatch(s, -1) {
		into[m[1]] = true
	}
}

// blockText pulls mrkdwn/plain text out of Block Kit section/header/context
// blocks (rich_text is mirrored in Msg.Text already).
func blockText(raw json.RawMessage) []string {
	if len(raw) == 0 || raw[0] != '[' {
		return nil
	}
	var blocks []struct {
		Type string `json:"type"`
		Text *struct {
			Text string `json:"text"`
		} `json:"text"`
		Fields []struct {
			Text string `json:"text"`
		} `json:"fields"`
		Elements []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"elements"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return nil
	}
	var out []string
	for _, b := range blocks {
		switch b.Type {
		case "section", "header":
			if b.Text != nil {
				out = append(out, b.Text.Text)
			}
			for _, f := range b.Fields {
				out = append(out, f.Text)
			}
		case "context":
			for _, e := range b.Elements {
				if e.Type == "mrkdwn" || e.Type == "plain_text" {
					out = append(out, e.Text)
				}
			}
		}
	}
	return out
}

// SearchBody builds the full-text body for a message.
func SearchBody(m *Msg, n Names) string {
	var parts []string
	add := func(s string) {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	add(PlainText(m.Text, n))
	blockParts := blockText(m.Blocks)
	if strings.TrimSpace(m.Text) == "" || m.BotID != "" {
		for _, t := range blockParts {
			add(PlainText(t, n))
		}
	}
	for _, a := range m.Attachments {
		add(PlainText(a.Pretext, n))
		add(PlainText(a.AuthorName, n))
		add(PlainText(a.Title, n))
		add(PlainText(a.Text, n))
		for _, f := range a.Fields {
			add(PlainText(f.Title, n))
			add(PlainText(f.Value, n))
		}
		add(PlainText(a.Footer, n))
		if a.Text == "" && a.Title == "" && len(a.Fields) == 0 {
			add(PlainText(a.Fallback, n))
		}
	}
	for _, f := range m.Files {
		if f.Mode == "tombstone" {
			continue
		}
		add(f.Title)
		if f.Name != f.Title {
			add(f.Name)
		}
		if f.Mode == "snippet" || f.Mode == "post" {
			add(f.Preview)
		}
	}
	return strings.Join(parts, "\n")
}

func hasLink(m *Msg) bool {
	if reBareLink.MatchString(m.Text) {
		return true
	}
	for _, a := range m.Attachments {
		if a.FromURL != "" || a.TitleLink != "" {
			return true
		}
	}
	return false
}
