// Package search implements Slack's search syntax over the index.
package search

import (
	"strings"
	"unicode"
)

// Term is a free-text search term.
type Term struct {
	Text   string `json:"text"`
	Phrase bool   `json:"phrase,omitempty"`
	Prefix bool   `json:"prefix,omitempty"` // trailing *
	Negate bool   `json:"negate,omitempty"`
}

// Filter is a modifier such as from:@x or before:2024-01-01.
type Filter struct {
	Key    string `json:"key"`   // from, in, with, to, before, after, on, during, has, is
	Value  string `json:"value"` // raw value (without leading @/# stripped)
	Negate bool   `json:"negate,omitempty"`
}

// Query is a parsed search query.
type Query struct {
	Terms   []Term   `json:"terms"`
	Filters []Filter `json:"filters"`
}

var filterKeys = map[string]bool{
	"from": true, "in": true, "with": true, "to": true,
	"before": true, "after": true, "on": true, "during": true,
	"has": true, "is": true,
}

// Parse parses a Slack-style query. It never fails: anything it doesn't
// understand becomes a plain term.
func Parse(q string) Query {
	var out Query
	toks := tokenize(q)
	for _, t := range toks {
		neg := false
		s := t.s
		if !t.quoted && len(s) > 1 && s[0] == '-' {
			neg, s = true, s[1:]
		}
		if t.quoted {
			if txt := strings.TrimSpace(s); txt != "" {
				out.Terms = append(out.Terms, Term{Text: txt, Phrase: strings.ContainsAny(txt, " \t"), Negate: t.neg})
			}
			continue
		}
		if i := strings.IndexByte(s, ':'); i > 0 && i < len(s)-1 {
			key := strings.ToLower(s[:i])
			if filterKeys[key] {
				out.Filters = append(out.Filters, Filter{Key: key, Value: s[i+1:], Negate: neg})
				continue
			}
		}
		prefix := false
		if strings.HasSuffix(s, "*") {
			prefix, s = true, strings.TrimRight(s, "*")
		}
		// Split on punctuation the tokenizer would split on anyway, keep
		// words; "foo.bar" becomes a phrase "foo bar".
		words := splitWords(s)
		switch len(words) {
		case 0:
			continue
		case 1:
			out.Terms = append(out.Terms, Term{Text: words[0], Prefix: prefix, Negate: neg})
		default:
			out.Terms = append(out.Terms, Term{Text: strings.Join(words, " "), Phrase: true, Prefix: prefix, Negate: neg})
		}
	}
	return out
}

type token struct {
	s      string
	quoted bool
	neg    bool
}

// tokenize splits on whitespace, honoring "double quotes" (also inside a
// filter value: in:"my channel"), and smart quotes.
func tokenize(q string) []token {
	q = strings.NewReplacer("“", `"`, "”", `"`, "‘", "'", "’", "'").Replace(q)
	var toks []token
	var cur strings.Builder
	inQuote := false
	quoteStartedToken := false
	neg := false
	flush := func(quoted bool) {
		if cur.Len() > 0 || quoted {
			toks = append(toks, token{s: cur.String(), quoted: quoted, neg: neg})
		}
		cur.Reset()
		neg = false
		quoteStartedToken = false
	}
	for _, r := range q {
		switch {
		case r == '"':
			if inQuote {
				inQuote = false
				if quoteStartedToken {
					flush(true)
				}
				continue
			}
			inQuote = true
			if cur.Len() == 0 {
				quoteStartedToken = true
			} else if cur.String() == "-" {
				cur.Reset()
				neg = true
				quoteStartedToken = true
			}
		case unicode.IsSpace(r) && !inQuote:
			flush(false)
		default:
			cur.WriteRune(r)
		}
	}
	flush(quoteStartedToken)
	return toks
}

// splitWords splits a term into word tokens the way unicode61 would.
func splitWords(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		return !(unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || unicode.Is(unicode.Mn, r))
	})
}

// String renders the query back to text (normalized).
func (q Query) String() string {
	var parts []string
	for _, f := range q.Filters {
		p := f.Key + ":" + f.Value
		if strings.ContainsAny(f.Value, " \t") {
			p = f.Key + `:"` + f.Value + `"`
		}
		if f.Negate {
			p = "-" + p
		}
		parts = append(parts, p)
	}
	for _, t := range q.Terms {
		p := t.Text
		if t.Phrase {
			p = `"` + p + `"`
		}
		if t.Prefix {
			p += "*"
		}
		if t.Negate {
			p = "-" + p
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, " ")
}
