// API proxy (v4.9): the page sends its sheet calls to the exe, and the exe's
// Go HTTP client talks to script.google.com. Antivirus web-shields and picky
// networks that strangle WebView fetches don't touch this path — it's the same
// engine that already handles OTA downloads and browser sign-in reliably.
package main

import (
	"io"
	"net/http"
	"strings"
	"time"
)

var proxyClient = &http.Client{Timeout: 60 * time.Second}

// allowedTarget keeps the proxy pointed only at the studio API (or loopback
// mocks during development) — never a general-purpose relay.
func allowedTarget(u string) bool {
	return strings.HasPrefix(u, "https://script.google.com/") ||
		strings.HasPrefix(u, "https://script.googleusercontent.com/") ||
		strings.HasPrefix(u, "http://127.0.0.1:") ||
		strings.HasPrefix(u, "http://localhost:")
}

func handleAPIProxy(w http.ResponseWriter, r *http.Request) {
	beat()
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		return
	}
	target := apiURL()
	if u := r.URL.Query().Get("u"); u != "" && allowedTarget(u) {
		target = u
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	if err != nil {
		w.WriteHeader(400)
		return
	}
	resp, err := proxyClient.Post(target, "text/plain;charset=utf-8", strings.NewReader(string(body)))
	if err != nil {
		// 200 on purpose: the page reads ok/error from the JSON; a raw 502 would
		// only add console noise on machines where the fallback path saves the day.
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(200)
		w.Write([]byte(`{"ok":false,"error":"PROXY","message":"The desktop app could not reach the sheet API (` + strings.ReplaceAll(err.Error(), `"`, `'`) + `). Check the internet connection."}`))
		return
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	w.Write(out)
}

func registerProxy(mux *http.ServeMux) {
	mux.HandleFunc("/api", handleAPIProxy)
}
