package archive

import (
	"net/url"
	"runtime"
	"testing"
)

func TestSQLiteURI(t *testing.T) {
	ro := url.Values{"immutable": {"1"}}
	if runtime.GOOS == "windows" {
		got := SQLiteURI(`C:\Users\Pat Example\My Archive #1\slackdump.sqlite`, ro)
		want := "file:///C:/Users/Pat%20Example/My%20Archive%20%231/slackdump.sqlite?immutable=1"
		if got != want {
			t.Errorf("got %s\nwant %s", got, want)
		}
		return
	}
	got := SQLiteURI("/Users/pat/My Archive #1/ünï?.sqlite", ro)
	want := "file:///Users/pat/My%20Archive%20%231/%C3%BCn%C3%AF%3F.sqlite?immutable=1"
	if got != want {
		t.Errorf("got %s\nwant %s", got, want)
	}
	// drive-letter paths get a leading slash on any OS
	if got := SQLiteURI("C:/x/y.sqlite", nil); got != "file:///C:/x/y.sqlite" {
		t.Errorf("drive path: %s", got)
	}
}

func TestValidFileID(t *testing.T) {
	for id, ok := range map[string]bool{"F0BAFSCMD54": true, "FASTF0BLP": true, "../etc": false, "f01": false, "F0/X": false, "": false} {
		if ValidFileID(id) != ok {
			t.Errorf("ValidFileID(%q) != %v", id, ok)
		}
	}
}
