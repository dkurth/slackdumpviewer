package search

import (
	"reflect"
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	cases := []struct {
		in    string
		terms []Term
		filts []Filter
	}{
		{"hello world", []Term{{Text: "hello"}, {Text: "world"}}, nil},
		{`"exact phrase" other`, []Term{{Text: "exact phrase", Phrase: true}, {Text: "other"}}, nil},
		{`-skip keep`, []Term{{Text: "skip", Negate: true}, {Text: "keep"}}, nil},
		{`-"not this"`, []Term{{Text: "not this", Phrase: true, Negate: true}}, nil},
		{`rep*`, []Term{{Text: "rep", Prefix: true}}, nil},
		{`from:@alice in:#general deploy`, []Term{{Text: "deploy"}}, []Filter{{Key: "from", Value: "@alice"}, {Key: "in", Value: "#general"}}},
		{`-in:#random has::tada: before:2024-01-01`, nil, []Filter{{Key: "in", Value: "#random", Negate: true}, {Key: "has", Value: ":tada:"}, {Key: "before", Value: "2024-01-01"}}},
		{`in:"my channel" x`, []Term{{Text: "x"}}, []Filter{{Key: "in", Value: "my channel"}}},
		{`foo.bar`, []Term{{Text: "foo bar", Phrase: true}}, nil},
		{`http: notafilter:x`, []Term{{Text: "http"}, {Text: "notafilter x", Phrase: true}}, nil},
		{`“smart quotes”`, []Term{{Text: "smart quotes", Phrase: true}}, nil},
		{`FROM:me`, nil, []Filter{{Key: "from", Value: "me"}}},
		{`"unterminated`, []Term{{Text: "unterminated"}}, nil},
	}
	for _, c := range cases {
		q := Parse(c.in)
		if !reflect.DeepEqual(q.Terms, c.terms) {
			t.Errorf("Parse(%q) terms = %+v, want %+v", c.in, q.Terms, c.terms)
		}
		if !reflect.DeepEqual(q.Filters, c.filts) {
			t.Errorf("Parse(%q) filters = %+v, want %+v", c.in, q.Filters, c.filts)
		}
	}
}

func TestMatchExprs(t *testing.T) {
	pos, neg, words := MatchExprs(Parse(`deploy "go live" rep* -friday -"no way"`).Terms)
	if pos != `"deploy" "go live" "rep"*` {
		t.Errorf("pos = %s", pos)
	}
	if neg != `"friday" OR "no way"` {
		t.Errorf("neg = %s", neg)
	}
	if !reflect.DeepEqual(words, []string{"deploy", "go", "live", "rep"}) {
		t.Errorf("words = %v", words)
	}
	// quotes inside terms are escaped
	pos, _, _ = MatchExprs([]Term{{Text: `a"b`}})
	if pos != `"a""b"` {
		t.Errorf("escape: %s", pos)
	}
}

func TestDateRange(t *testing.T) {
	loc, _ := time.LoadLocation("America/Los_Angeles")
	now := time.Date(2026, 11, 21, 10, 0, 0, 0, loc) // a Saturday
	d := func(y int, m time.Month, dd int) time.Time { return time.Date(y, m, dd, 0, 0, 0, 0, loc) }
	cases := []struct {
		in         string
		start, end time.Time
	}{
		{"2024-03-05", d(2024, 3, 5), d(2024, 3, 6)},
		{"3/5/2024", d(2024, 3, 5), d(2024, 3, 6)},
		{"2024-03", d(2024, 3, 1), d(2024, 4, 1)},
		{"2023", d(2023, 1, 1), d(2024, 1, 1)},
		{"today", d(2026, 11, 21), d(2026, 11, 22)},
		{"yesterday", d(2026, 11, 20), d(2026, 11, 21)},
		{"march", d(2026, 3, 1), d(2026, 4, 1)},
		{"december", d(2025, 12, 1), d(2026, 1, 1)}, // most recent past December
		{"march-2024", d(2024, 3, 1), d(2024, 4, 1)},
		{"monday", d(2026, 11, 16), d(2026, 11, 17)},
		{"month", d(2026, 11, 1), d(2026, 12, 1)},
		{"week", d(2026, 11, 15), d(2026, 11, 22)},
	}
	for _, c := range cases {
		s, e, ok := DateRange(c.in, now, loc)
		if !ok || !s.Equal(c.start) || !e.Equal(c.end) {
			t.Errorf("DateRange(%q) = %v..%v %v, want %v..%v", c.in, s, e, ok, c.start, c.end)
		}
	}
	if _, _, ok := DateRange("notadate", now, loc); ok {
		t.Error("notadate parsed")
	}
}
