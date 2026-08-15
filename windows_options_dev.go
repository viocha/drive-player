//go:build windows && !production

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func platformWindowsOptions() application.WindowsOptions {
	return application.WindowsOptions{
		AdditionalBrowserArgs: []string{"--remote-debugging-port=9223"},
	}
}
