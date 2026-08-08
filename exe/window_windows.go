//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"

	webview2 "github.com/jchv/go-webview2"
)

// openAppWindow opens the CreativeFlow window.
// Returns true if it blocked until the window closed (native WebView2 path),
// false if it launched an external browser window and returned immediately.
func openAppWindow(url string) bool {
	// v4.9.2: user-forced browser mode (open-in-browser.txt beside the exe, or
	// CF_OPEN_IN=browser) — the dashboard opens in Chrome/Edge, which uses the
	// system browser's network stack; the exe stays alive as the local engine.
	if browserMode() {
		launchBrowserWindow(url)
		return false
	}

	dataDir := filepath.Join(os.Getenv("LocalAppData"), "CreativeFlowV3", "WebView2Data")
	_ = os.MkdirAll(dataDir, 0o755)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  dataDir,
		WindowOptions: webview2.WindowOptions{
			Title:  "CreativeFlow",
			Width:  1440,
			Height: 920,
			IconId: 1, // icon resource compiled into CreativeFlow.exe (app.rc)
			Center: true,
		},
	})
	if w != nil {
		defer w.Destroy()
		w.Navigate(url)
		w.Run() // blocks until the window is closed
		return true
	}

	// WebView2 runtime not available — fall back to an Edge/Chrome app window.
	launchBrowserWindow(url)
	return false
}

func launchBrowserWindow(url string) {
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	lad := os.Getenv("LocalAppData")
	candidates := []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(lad, `Google\Chrome\Application\chrome.exe`),
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if _, err := os.Stat(c); err == nil {
			if exec.Command(c, "--app="+url, "--window-size=1440,920").Start() == nil {
				return
			}
		}
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
