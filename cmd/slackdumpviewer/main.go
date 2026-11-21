// Command slackdumpviewer serves a Slack-like, read-only viewer for a
// slackdump archive.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // IANA zones on Windows

	"github.com/dkurth/slackdumpviewer/internal/aliases"
	"github.com/dkurth/slackdumpviewer/internal/archive"
	"github.com/dkurth/slackdumpviewer/internal/index"
	"github.com/dkurth/slackdumpviewer/internal/launch"
	"github.com/dkurth/slackdumpviewer/internal/server"
)

var version = "dev"

const usage = `slackdumpviewer — a Slack-like viewer for slackdump archives

Usage:
  slackdumpviewer [flags] <archive-dir | slackdump.sqlite>
  slackdumpviewer aliases suggest [flags] <archive-dir>

Flags:
`

func main() {
	if len(os.Args) > 2 && os.Args[1] == "aliases" {
		os.Exit(aliasesCmd(os.Args[2:]))
	}
	fs := flag.NewFlagSet("slackdumpviewer", flag.ExitOnError)
	port := fs.Int("port", 0, "port to listen on (default: a stable port derived from the archive path)")
	tab := fs.Bool("tab", false, "open in a normal browser tab instead of an app window")
	noOpen := fs.Bool("no-open", false, "don't open anything; just print the URL")
	reindex := fs.Bool("reindex", false, "rebuild the search index")
	cacheDir := fs.String("cache-dir", "", "where the viewer keeps its files (default: <archive>/.slackdumpviewer)")
	showVersion := fs.Bool("version", false, "print version and exit")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, usage)
		fs.PrintDefaults()
	}
	fs.Parse(reorderArgs(os.Args[1:]))
	if *showVersion {
		fmt.Println("slackdumpviewer", version)
		return
	}
	if fs.NArg() != 1 {
		fs.Usage()
		os.Exit(2)
	}
	if v := os.Getenv("SLACKDUMPVIEWER_NO_OPEN"); v != "" && v != "0" {
		*noOpen = true
	}
	if err := run(fs.Arg(0), *port, *tab, *noOpen, *reindex, *cacheDir); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// reorderArgs lets flags come after the archive path.
func reorderArgs(args []string) []string {
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			flags = append(flags, a)
			name := strings.TrimLeft(a, "-")
			if !strings.Contains(name, "=") && (name == "port" || name == "cache-dir") && i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
			continue
		}
		pos = append(pos, a)
	}
	return append(flags, pos...)
}

func logf(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }

// viewerDir picks <archive>/.slackdumpviewer, falling back to the OS cache
// dir if the archive folder isn't writable.
func viewerDir(a *archive.Archive, override string) (string, error) {
	if override != "" {
		return override, os.MkdirAll(override, 0o755)
	}
	dir := filepath.Join(a.Dir, ".slackdumpviewer")
	if err := os.MkdirAll(dir, 0o755); err == nil {
		probe := filepath.Join(dir, ".write-test")
		if err := os.WriteFile(probe, nil, 0o644); err == nil {
			os.Remove(probe)
			writeReadme(dir)
			hideOnWindows(dir)
			return dir, nil
		}
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return "", errors.New("archive folder isn't writable and no user cache dir is available; use --cache-dir")
	}
	h := sha256.Sum256([]byte(a.Dir))
	dir = filepath.Join(base, "slackdumpviewer", hex.EncodeToString(h[:8]))
	logf("Note: %s isn't writable; keeping viewer files in %s", a.Dir, dir)
	return dir, os.MkdirAll(dir, 0o755)
}

func writeReadme(dir string) {
	p := filepath.Join(dir, "README.txt")
	if _, err := os.Stat(p); err == nil {
		return
	}
	os.WriteFile(p, []byte(`This folder belongs to slackdumpviewer, not slackdump.

It holds the viewer's search index, image thumbnails, the browser profile for
the app window, and aliases.json (your user-alias decisions).

Everything here except aliases.json is rebuilt automatically, so it's safe to
delete the folder (keep aliases.json if you've reviewed aliases).
`), 0o644)
}

func hideOnWindows(dir string) {
	if runtime.GOOS == "windows" {
		exec.Command("attrib", "+h", dir).Run()
	}
}

func run(path string, port int, tab, noOpen, reindex bool, cacheOverride string) error {
	a, err := archive.Open(path)
	if err != nil {
		return err
	}
	defer a.Close()
	if a.InUse {
		logf("Warning: %s-wal exists, so slackdump may be running. The archive was opened read-only and may change while you view it.", filepath.Base(a.DBPath))
	}
	dir, err := viewerDir(a, cacheOverride)
	if err != nil {
		return err
	}
	srv, err := server.New(server.Config{Archive: a, CacheDir: dir, Reindex: reindex, Logf: logf})
	if err != nil {
		return err
	}
	defer srv.Close()

	ln, err := listen(a.Dir, port)
	if err != nil {
		return err
	}
	url := "http://" + ln.Addr().String() + "/"
	hs := &http.Server{Handler: srv.Handler(server.AllowedHosts(ln.Addr())), ReadHeaderTimeout: 10 * time.Second}
	go hs.Serve(ln)

	// Index: open immediately if fresh, otherwise build in the background
	// while the UI shows progress.
	idxDone := make(chan error, 1)
	go func() {
		start := time.Now()
		lastLine := ""
		err := srv.EnsureIndex(func(p index.Progress) {
			line := p.Phase
			if p.Total > 0 {
				line = fmt.Sprintf("%s: %d%% (%d/%d messages)", p.Phase, p.Done*100/p.Total, p.Done, p.Total)
			}
			if line != lastLine {
				fmt.Fprintf(os.Stderr, "\r\033[K%s", line)
				lastLine = line
			}
		})
		if lastLine != "" {
			fmt.Fprintf(os.Stderr, "\r\033[KIndex ready (%s)\n", time.Since(start).Round(100*time.Millisecond))
		}
		idxDone <- err
	}()

	fmt.Fprintf(os.Stderr, "slackdumpviewer %s — %s\n", version, a.Dir)
	fmt.Fprintf(os.Stderr, "Serving on %s  (Ctrl+C to stop)\n", url)

	var appExit chan error
	switch {
	case noOpen:
	case tab:
		launch.Tab(url)
	default:
		if b := launch.FindAppBrowser(); b != "" {
			cmd, err := launch.AppWindow(b, url, filepath.Join(dir, "browser-profile"))
			if err != nil {
				logf("Couldn't start app window (%v); opening a browser tab instead.", err)
				launch.Tab(url)
			} else {
				appExit = make(chan error, 1)
				started := time.Now()
				go func() {
					err := cmd.Wait()
					// If the browser handed off to an already-running
					// instance it exits immediately; keep serving then.
					if time.Since(started) < 3*time.Second {
						return
					}
					appExit <- err
				}()
			}
		} else {
			logf("No Chrome/Edge/Brave/Chromium found; opening a browser tab instead.")
			launch.Tab(url)
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	for {
		select {
		case err := <-idxDone:
			if err != nil {
				logf("Indexing failed: %v", err)
			}
			idxDone = nil
		case <-sig:
			fmt.Fprintln(os.Stderr)
			return nil
		case <-appExit:
			logf("Viewer window closed; stopping.")
			return nil
		}
	}
}

// listen binds 127.0.0.1. With port 0 it first tries a port derived from the
// archive path, so the browser origin (and its saved preferences) stays the
// same between launches; if that's taken it falls back to a random port.
func listen(archiveDir string, port int) (net.Listener, error) {
	if port != 0 {
		return net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	}
	h := sha256.Sum256([]byte(archiveDir))
	stable := 20000 + (int(h[0])<<8|int(h[1]))%10000
	if ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(stable)); err == nil {
		return ln, nil
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

func aliasesCmd(args []string) int {
	if len(args) < 1 || args[0] != "suggest" {
		fmt.Fprintln(os.Stderr, "usage: slackdumpviewer aliases suggest [--cache-dir DIR] <archive-dir>")
		return 2
	}
	fs := flag.NewFlagSet("aliases suggest", flag.ExitOnError)
	cacheDir := fs.String("cache-dir", "", "viewer files location (default: <archive>/.slackdumpviewer)")
	fs.Parse(reorderArgs(args[1:]))
	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: slackdumpviewer aliases suggest [--cache-dir DIR] <archive-dir>")
		return 2
	}
	a, err := archive.Open(fs.Arg(0))
	if err != nil {
		logf("error: %v", err)
		return 1
	}
	defer a.Close()
	dir, err := viewerDir(a, *cacheDir)
	if err != nil {
		logf("error: %v", err)
		return 1
	}
	srv, err := server.New(server.Config{Archive: a, CacheDir: dir, Logf: logf})
	if err != nil {
		logf("error: %v", err)
		return 1
	}
	defer srv.Close()
	if err := srv.EnsureIndex(nil); err != nil {
		logf("error: %v", err)
		return 1
	}
	n, err := srv.SuggestAliases()
	if err != nil {
		logf("error: %v", err)
		return 1
	}
	st, _ := aliases.Load(filepath.Join(dir, "aliases.json"))
	logf("Wrote %d suggestions to %s", n, st.Path())
	return 0
}
