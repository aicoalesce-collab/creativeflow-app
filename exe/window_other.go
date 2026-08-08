//go:build !windows

package main

import (
	"os/exec"
	"runtime"
)

func openAppWindow(url string) bool {
	if runtime.GOOS == "darwin" {
		exec.Command("open", url).Start()
	} else {
		exec.Command("xdg-open", url).Start()
	}
	return false
}
