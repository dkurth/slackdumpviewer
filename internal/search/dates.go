package search

import (
	"strconv"
	"strings"
	"time"
)

// DateRange returns [start, end) for a date expression in loc, relative to now.
// Supported: 2024-03-05, 2024-03, 2024, 3/5/2024, 03/05/24, today, yesterday,
// week, month, year, last-week? (no), month names (january, jan,
// "march-2024"), weekday names (monday = the most recent one).
func DateRange(s string, now time.Time, loc *time.Location) (time.Time, time.Time, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	now = now.In(loc)
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc) }
	today := day(now)
	switch s {
	case "today":
		return today, today.AddDate(0, 0, 1), true
	case "yesterday":
		return today.AddDate(0, 0, -1), today, true
	case "week", "this-week", "thisweek":
		start := today.AddDate(0, 0, -int(today.Weekday()))
		return start, start.AddDate(0, 0, 7), true
	case "month", "this-month":
		start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc)
		return start, start.AddDate(0, 1, 0), true
	case "year", "this-year":
		start := time.Date(now.Year(), 1, 1, 0, 0, 0, 0, loc)
		return start, start.AddDate(1, 0, 0), true
	}
	for _, layout := range []string{"2006-01-02", "2006/01/02", "1/2/2006", "01/02/2006", "1/2/06", "01/02/06", "2006-1-2", "1-2-2006"} {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, t.AddDate(0, 0, 1), true
		}
	}
	for _, layout := range []string{"2006-01", "2006/01", "1/2006", "01/2006", "2006-1"} {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, t.AddDate(0, 1, 0), true
		}
	}
	if len(s) == 4 {
		if y, err := strconv.Atoi(s); err == nil && y > 1990 && y < 2200 {
			t := time.Date(y, 1, 1, 0, 0, 0, 0, loc)
			return t, t.AddDate(1, 0, 0), true
		}
	}
	// month name, optionally with year: "march", "march-2024", "mar_2024"
	name, yearStr := s, ""
	for _, sep := range []string{"-", "_", " ", ","} {
		if i := strings.Index(s, sep); i > 0 {
			name, yearStr = s[:i], strings.TrimLeft(s[i+1:], "-_ ,")
			break
		}
	}
	if m, ok := monthByName(name); ok {
		y := now.Year()
		if yearStr != "" {
			if v, err := strconv.Atoi(yearStr); err == nil {
				y = v
			} else {
				return time.Time{}, time.Time{}, false
			}
		} else if m > now.Month() {
			y-- // most recent past occurrence
		}
		start := time.Date(y, m, 1, 0, 0, 0, 0, loc)
		return start, start.AddDate(0, 1, 0), true
	}
	if wd, ok := weekdayByName(s); ok {
		diff := (int(today.Weekday()) - int(wd) + 7) % 7
		start := today.AddDate(0, 0, -diff)
		return start, start.AddDate(0, 0, 1), true
	}
	return time.Time{}, time.Time{}, false
}

func monthByName(s string) (time.Month, bool) {
	if len(s) < 3 {
		return 0, false
	}
	for m := time.January; m <= time.December; m++ {
		full := strings.ToLower(m.String())
		if s == full || (len(s) >= 3 && strings.HasPrefix(full, s)) {
			return m, true
		}
	}
	if s == "sept" {
		return time.September, true
	}
	return 0, false
}

func weekdayByName(s string) (time.Weekday, bool) {
	if len(s) < 3 {
		return 0, false
	}
	for d := time.Sunday; d <= time.Saturday; d++ {
		full := strings.ToLower(d.String())
		if s == full || strings.HasPrefix(full, s) {
			return d, true
		}
	}
	return 0, false
}
