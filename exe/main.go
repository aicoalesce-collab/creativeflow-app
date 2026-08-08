// CreativeFlow desktop wrapper (v5).
//
// Serves the embedded dashboard on http://127.0.0.1:4879 and opens it in an
// app-style window. The embedded model is deliberate: the page stays
// same-origin with the /api proxy, so no CORS and no Private Network Access
// preflights, and the app keeps working when the hosted PWA is unreachable.
// Port 4879 is fixed — it is a registered Google OAuth JS origin (uploads).
//
// A CreativeFlowV3.html beside the EXE overrides the embedded copy, and OTA
// updates land in the user cache; newest version wins across all three.
package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

//go:embed app/index.html
var embeddedApp []byte

const port = 4879

var lastBeat atomic.Int64

func beat() { lastBeat.Store(time.Now().Unix()) }

// browserMode: open the dashboard in the system browser instead of the built-in
// window. Escape hatch for PCs whose WebView runtime misbehaves — create an
// empty file named open-in-browser.txt next to the exe (or set CF_OPEN_IN=browser).
// The exe keeps running as the local engine; the page's /alive pings keep it up.
func browserMode() bool {
	if os.Getenv("CF_OPEN_IN") == "browser" {
		return true
	}
	if exe, err := os.Executable(); err == nil {
		if _, err := os.Stat(filepath.Join(filepath.Dir(exe), "open-in-browser.txt")); err == nil {
			return true
		}
	}
	return false
}

// cachePath is where OTA updates land (e.g. %LocalAppData%\CreativeFlow\app.html).
func cachePath() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "CreativeFlowV3", "app.html")
}

// appVer pulls APP_VERSION out of an app build ("4.9" → [4,9]).
var verRe = regexp.MustCompile(`APP_VERSION\s*=\s*'([^']+)'`)

func appVer(b []byte) []int {
	m := verRe.FindSubmatch(b)
	if m == nil {
		return nil
	}
	var out []int
	for _, p := range strings.Split(string(m[1]), ".") {
		n, _ := strconv.Atoi(p)
		out = append(out, n)
	}
	return out
}

func verNewer(a, b []int) bool { // a > b
	for i := 0; i < len(a) || i < len(b); i++ {
		x, y := 0, 0
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// Newest build wins across: file beside the exe → installed OTA update → embedded copy.
// (v4.9: previously the side file / OTA cache always won — so a stale cache could
// shadow a NEWER embedded build after the exe itself was upgraded. Now versions decide;
// earlier sources win ties so a hand-dropped side file still takes effect.)
func appHTML() []byte {
	best := embeddedApp
	bestV := appVer(embeddedApp)
	consider := func(b []byte) {
		if len(b) == 0 {
			return
		}
		if v := appVer(b); v != nil && verNewer(v, bestV) {
			best, bestV = b, v
		}
	}
	if cp := cachePath(); cp != "" {
		if b, err := os.ReadFile(cp); err == nil {
			consider(b)
		}
	}
	if exe, err := os.Executable(); err == nil {
		side := filepath.Join(filepath.Dir(exe), "CreativeFlowV3.html")
		if b, err := os.ReadFile(side); err == nil && len(b) > 0 {
			if v := appVer(b); v == nil || !verNewer(bestV, v) {
				best, bestV = b, v // side file wins unless strictly older
			}
		}
	}
	return best
}

// installUpdate persists a new app build delivered by the page (OTA).
func installUpdate(body []byte) bool {
	if !bytes.Contains(body[:min(len(body), 400)], []byte("<!DOCTYPE html")) || !bytes.Contains(body, []byte("CreativeFlow")) {
		return false
	}
	cp := cachePath()
	if cp == "" {
		return false
	}
	if err := os.MkdirAll(filepath.Dir(cp), 0o755); err != nil {
		return false
	}
	tmp := cp + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return false
	}
	return os.Rename(tmp, cp) == nil
}

func main() {
	url := fmt.Sprintf("http://localhost:%d/", port)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		// Already running — just open another window onto it.
		openAppWindow(url)
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		beat()
		if r.URL.Path == "/alive" {
			w.WriteHeader(200)
			w.Write([]byte("ok"))
			return
		}
		if r.URL.Path == "/update" && r.Method == http.MethodPost {
			body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
			if err == nil && installUpdate(body) {
				w.WriteHeader(200)
				w.Write([]byte("installed"))
			} else {
				w.WriteHeader(400)
				w.Write([]byte("rejected"))
			}
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(appHTML())
	})

	registerProxy(mux) // page API calls ride the exe's network engine (AV-proof)

	beat()
	go http.Serve(ln, mux)

	if os.Getenv("CF_NO_BROWSER") == "" {
		if openAppWindow(url) {
			return // native window closed — shut down with it
		}
	}

	// Exit when the window is gone: the page pings /alive every 15s.
	// Generous grace period covers slow startups.
	start := time.Now()
	for {
		time.Sleep(10 * time.Second)
		idle := time.Now().Unix() - lastBeat.Load()
		if idle > 90 && time.Since(start) > 3*time.Minute {
			return
		}
	}
}
