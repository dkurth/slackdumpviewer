// Package launch opens the viewer in a Chromium-based app window (default)
// or a normal browser tab.
package launch

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// FindAppBrowser returns the path of a Chromium-based browser that supports
// --app, or "".
func FindAppBrowser() string {
	var cands []string
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		for _, base := range []string{"/Applications", filepath.Join(home, "Applications")} {
			cands = append(cands,
				filepath.Join(base, "Google Chrome.app/Contents/MacOS/Google Chrome"),
				filepath.Join(base, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				filepath.Join(base, "Brave Browser.app/Contents/MacOS/Brave Browser"),
				filepath.Join(base, "Chromium.app/Contents/MacOS/Chromium"),
			)
		}
	case "windows":
		pf, pf86, local := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LocalAppData")
		for _, base := range []string{pf, pf86, local} {
			if base == "" {
				continue
			}
			cands = append(cands,
				filepath.Join(base, `Google\Chrome\Application\chrome.exe`),
				filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
				filepath.Join(base, `BraveSoftware\Brave-Browser\Application\brave.exe`),
				filepath.Join(base, `Chromium\Application\chrome.exe`),
			)
		}
	default:
		for _, n := range []string{"google-chrome", "google-chrome-stable", "microsoft-edge", "brave-browser", "chromium", "chromium-browser"} {
			if p, err := exec.LookPath(n); err == nil {
				cands = append(cands, p)
			}
		}
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

// AppWindow starts browser in app mode with its own profile directory.
func AppWindow(browser, url, profileDir string) (*exec.Cmd, error) {
	cmd := exec.Command(browser,
		"--app="+url,
		"--user-data-dir="+profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate",
		"--window-size=1440,900",
	)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

// Tab opens url in the default browser.
func Tab(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
