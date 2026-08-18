package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newDualAccountTestService(t *testing.T) *AppService {
	t.Helper()

	proxy, err := NewWebDAVProxy(defaultWebDAVEndpoint, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	quark, err := NewQuarkDrive(time.Minute, time.Minute)
	if err != nil {
		_ = proxy.Close()
		t.Fatal(err)
	}
	progress, err := NewPlaybackProgressStore(
		filepath.Join(t.TempDir(), "playback-progress.json"),
		24*time.Hour,
		1024*1024,
	)
	if err != nil {
		_ = proxy.Close()
		_ = quark.Close()
		t.Fatal(err)
	}

	configPath := filepath.Join(t.TempDir(), "config.json")
	config := diskConfig{
		WebDAVCacheTTLMinutes:               defaultURLCacheTTL,
		QuarkDownloadCacheTTLMinutes:        defaultURLCacheTTL,
		QuarkIDCacheTTLMinutes:              defaultQuarkIDCacheTTL,
		VideoMetadataMaxAgeDays:             defaultVideoMetadataMaxAgeDays,
		VideoMetadataMaxSizeMB:              defaultVideoMetadataMaxSizeMB,
		VideoMetadataThumbnailOffsetPercent: defaultVideoMetadataThumbnailOffsetPercent,
		PlaybackMaxAgeDays:                  defaultPlaybackMaxAgeDays,
		PlaybackMaxSizeMB:                   defaultPlaybackMaxSizeMB,
		Username:                            "webdav-user",
		Password:                            "webdav-password",
		Provider:                            provider123,
		QuarkCookie:                         "quark-cookie",
	}
	service := &AppService{
		credentials:    credentials{username: config.Username, password: config.Password},
		provider:       provider123,
		quarkCookie:    config.QuarkCookie,
		connected123:   true,
		connectedQuark: true,
		config:         config,
		configPath:     configPath,
		proxy:          proxy,
		quark:          quark,
		progress:       progress,
	}
	proxy.SetCredentials(config.Username, config.Password)
	quark.SetCookie(config.QuarkCookie)
	t.Cleanup(func() { _ = service.close() })
	return service
}

func TestSwitchProviderKeepsBothSessionsConnected(t *testing.T) {
	service := newDualAccountTestService(t)

	state, err := service.SwitchProvider(providerQuark)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Connected || !state.Connected123 || !state.ConnectedQuark {
		t.Fatalf("expected both sessions connected, got %+v", state)
	}
	if state.Provider != providerQuark {
		t.Fatalf("expected active provider %q, got %q", providerQuark, state.Provider)
	}

	data, err := os.ReadFile(service.configPath)
	if err != nil {
		t.Fatal(err)
	}
	var saved diskConfig
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Provider != providerQuark || saved.Username == "" || saved.Password == "" || saved.QuarkCookie == "" {
		t.Fatalf("switch should persist only the active provider and retain both credentials: %+v", saved)
	}
}

func TestLogoutCurrentProviderFallsBackToOtherSession(t *testing.T) {
	service := newDualAccountTestService(t)
	if _, err := service.SwitchProvider(providerQuark); err != nil {
		t.Fatal(err)
	}

	state := service.Logout()
	if !state.Connected || !state.Connected123 || state.ConnectedQuark {
		t.Fatalf("expected only 123 session to remain connected, got %+v", state)
	}
	if state.Provider != provider123 {
		t.Fatalf("expected fallback to %q, got %q", provider123, state.Provider)
	}
	if state.Username == "" || state.Password == "" || state.QuarkCookie != "" {
		t.Fatalf("logout should clear only the active quark account: %+v", state)
	}
}
