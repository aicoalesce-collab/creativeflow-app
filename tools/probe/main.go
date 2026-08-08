// probe — the trustworthy live prober for Apps Script /exec endpoints.
//
// WebFetch-style tools and some HTTP stacks get 404s or mangled redirects from
// /exec; a Go HTTP client and a real browser are the only probes that tell the
// truth. Every deploy smoke check runs through this.
//
//	probe ping   <execUrl> [-expect-v 5] [-expect-app 5.0.0]
//	probe login  <execUrl> <email> <code>
//	probe admin  <execUrl> <email> <code> <opJSON>
//	probe call   <execUrl> <bodyJSON>   — any action, for one-off checks
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

var client = &http.Client{Timeout: 60 * time.Second}

const sizeCap = 16 * 1024 // every login-path answer must stay ping-sized

func post(url string, body map[string]any) (map[string]any, int, error) {
	b, _ := json.Marshal(body)
	resp, err := client.Post(url, "text/plain;charset=utf-8", strings.NewReader(string(b)))
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, len(raw), fmt.Errorf("not JSON (%d bytes): %.180s", len(raw), string(raw))
	}
	return out, len(raw), nil
}

func get(url string) (map[string]any, int, error) {
	resp, err := client.Get(url)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, len(raw), fmt.Errorf("not JSON (%d bytes): %.180s", len(raw), string(raw))
	}
	return out, len(raw), nil
}

func fail(format string, a ...any) {
	fmt.Printf("FAIL  "+format+"\n", a...)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 3 {
		fmt.Println("usage: probe <ping|login|admin|call> <execUrl> [...]")
		os.Exit(2)
	}
	cmd, url := os.Args[1], strings.TrimRight(os.Args[2], "/")

	switch cmd {
	case "ping":
		fs := flag.NewFlagSet("ping", flag.ExitOnError)
		expectV := fs.String("expect-v", "", "required API version")
		expectApp := fs.String("expect-app", "", "required client version")
		fs.Parse(os.Args[3:])

		j, n, err := get(url + "?action=ping")
		if err != nil {
			fail("ping: %v", err)
		}
		if j["ok"] != true {
			fail("ping: ok=false %v", j["message"])
		}
		v := fmt.Sprintf("%v", j["v"])
		app := fmt.Sprintf("%v", j["appVersion"])
		fmt.Printf("ok    ping  v=%s appVersion=%s org=%v emailMute=%v %d bytes\n", v, app, j["org"], j["emailMute"], n)
		if *expectV != "" && v != *expectV {
			fail("expected API v%s, got v%s", *expectV, v)
		}
		if *expectApp != "" && app != *expectApp {
			fail("expected app %s, got %s", *expectApp, app)
		}
		if n > 4096 {
			fail("ping answer is %d bytes — it must stay small", n)
		}

	case "login":
		if len(os.Args) < 5 {
			fail("usage: probe login <execUrl> <email> <code>")
		}
		email, code := os.Args[3], os.Args[4]
		j, n, err := post(url, map[string]any{"action": "bootstrap", "lite": 1, "email": email, "code": code})
		if err != nil {
			fail("bootstrap: %v", err)
		}
		if j["ok"] != true {
			fail("bootstrap: %v", j["message"])
		}
		if n > sizeCap {
			fail("lite bootstrap is %d bytes (cap %d) — the paged-login invariant is broken", n, sizeCap)
		}
		me, _ := j["me"].(map[string]any)
		fmt.Printf("ok    bootstrap lite  me=%v total=%v %d bytes\n", me["name"], j["total"], n)

		p, n2, err := post(url, map[string]any{"action": "tasksPage", "offset": 0, "limit": 25, "email": email, "code": code})
		if err != nil {
			fail("tasksPage: %v", err)
		}
		if p["ok"] != true {
			fail("tasksPage: %v", p["message"])
		}
		if n2 > sizeCap {
			fail("tasksPage is %d bytes (cap %d) — a monster row is inflating the page", n2, sizeCap)
		}
		fmt.Printf("ok    tasksPage       total=%v next=%v %d bytes\n", p["total"], p["next"], n2)

	case "call":
		// escape hatch: POST an arbitrary action body and print the answer.
		// Fetch-style tools mangle /exec, so anything ad-hoc has to come through here.
		if len(os.Args) < 4 {
			fail("usage: probe call <execUrl> <bodyJSON>")
		}
		var body map[string]any
		if err := json.Unmarshal([]byte(os.Args[3]), &body); err != nil {
			fail("body is not JSON: %v", err)
		}
		j, n, err := post(url, body)
		if err != nil {
			fail("%v", err)
		}
		out, _ := json.MarshalIndent(j, "", "  ")
		fmt.Printf("%s\n(%d bytes)\n", out, n)
		if j["ok"] != true {
			os.Exit(1)
		}

	case "admin":
		if len(os.Args) < 6 {
			fail("usage: probe admin <execUrl> <email> <code> <opJSON>")
		}
		var op map[string]any
		if err := json.Unmarshal([]byte(os.Args[5]), &op); err != nil {
			fail("opJSON: %v", err)
		}
		op["action"] = "admin"
		op["email"] = os.Args[3]
		op["code"] = os.Args[4]
		j, n, err := post(url, op)
		if err != nil {
			fail("admin: %v", err)
		}
		pretty, _ := json.MarshalIndent(j, "", "  ")
		fmt.Printf("%s\n(%d bytes)\n", pretty, n)
		if j["ok"] != true {
			os.Exit(1)
		}

	default:
		fail("unknown command %q", cmd)
	}
}
