//go:build !android

package main

import "os"

func resolveAppDataDirectory() (string, error) {
	return os.UserConfigDir()
}
