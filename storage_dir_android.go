//go:build android

package main

import (
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func resolveAppDataDirectory() (string, error) {
	base := application.Android.StoragePath()
	if base == "" {
		return "", fmt.Errorf("android app storage path is unavailable")
	}
	return base, nil
}
