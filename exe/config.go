// Baked configuration for the desktop wrapper.
//
// v5: oauth.go is GONE — the browser PKCE sign-in it implemented was retired in
// 4.9.2 by the owner's order (code-only login) and its server actions no longer
// exist. Only the API URL resolution it also carried survives, here.
package main

import "os"

// The studio's production /exec. Stamped by scripts/bake-url.ps1 at release
// time once the pinned PROD deployment exists; CF_API_URL overrides for tests.
const bakedAPI = "https://script.google.com/macros/s/PROD_DEPLOYMENT_ID_HERE/exec"

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func apiURL() string { return envOr("CF_API_URL", bakedAPI) }
