package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newMultiAccountTestService(t *testing.T) *AppService {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)

	accounts := []WebDAVAccount{
		{ID: "account-a", Name: "家庭盘", Endpoint: server.URL + "/dav-a", Username: "user-a", Password: "pass-a"},
		{ID: "account-b", Name: "工作盘", Endpoint: server.URL + "/dav-b", Username: "user-b", Password: "pass-b"},
	}
	proxy, err := NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	for _, account := range accounts {
		if err := proxy.SetAccount(account); err != nil {
			_ = proxy.Close()
			t.Fatal(err)
		}
	}

	progress, err := NewPlaybackProgressStore(
		filepath.Join(t.TempDir(), "playback-progress.json"),
		24*time.Hour,
		1024*1024,
	)
	if err != nil {
		_ = proxy.Close()
		t.Fatal(err)
	}

	configPath := filepath.Join(t.TempDir(), "config.json")
	config := diskConfig{
		Accounts:                            accounts,
		ActiveAccountID:                     accounts[0].ID,
		VideoMetadataMaxAgeDays:             defaultVideoMetadataMaxAgeDays,
		VideoMetadataMaxSizeMB:              defaultVideoMetadataMaxSizeMB,
		VideoMetadataThumbnailOffsetPercent: defaultVideoMetadataThumbnailOffsetPercent,
		VideoSnapshotMaxAgeDays:             defaultVideoSnapshotMaxAgeDays,
		VideoSnapshotMaxSizeMB:              defaultVideoSnapshotMaxSizeMB,
		PlaybackMaxAgeDays:                  defaultPlaybackMaxAgeDays,
		PlaybackMaxSizeMB:                   defaultPlaybackMaxSizeMB,
	}
	service := &AppService{
		config:     config,
		configPath: configPath,
		proxy:      proxy,
		progress:   progress,
	}
	t.Cleanup(func() { _ = service.close() })
	return service
}

func TestSwitchWebDAVAccountKeepsAllAccounts(t *testing.T) {
	service := newMultiAccountTestService(t)

	state, err := service.SwitchWebDAVAccount("account-b")
	if err != nil {
		t.Fatal(err)
	}
	if !state.Connected || len(state.Accounts) != 2 {
		t.Fatalf("expected two configured accounts, got %+v", state)
	}
	if state.ActiveAccountID != "account-b" {
		t.Fatalf("expected active account-b, got %q", state.ActiveAccountID)
	}

	data, err := os.ReadFile(service.configPath)
	if err != nil {
		t.Fatal(err)
	}
	var saved diskConfig
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.ActiveAccountID != "account-b" || len(saved.Accounts) != 2 {
		t.Fatalf("switch should only change active account: %+v", saved)
	}
}

func TestRemoveActiveWebDAVAccountFallsBackToFirstRemaining(t *testing.T) {
	service := newMultiAccountTestService(t)
	if _, err := service.SwitchWebDAVAccount("account-b"); err != nil {
		t.Fatal(err)
	}

	state, err := service.RemoveWebDAVAccount("account-b")
	if err != nil {
		t.Fatal(err)
	}
	if !state.Connected || len(state.Accounts) != 1 {
		t.Fatalf("expected one configured account, got %+v", state)
	}
	if state.ActiveAccountID != "account-a" {
		t.Fatalf("expected fallback to account-a, got %q", state.ActiveAccountID)
	}
	if state.Accounts[0].Name != "家庭盘" {
		t.Fatalf("unexpected remaining account: %+v", state.Accounts[0])
	}
}

func TestAddAndUpdateWebDAVAccount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PROPFIND" {
			t.Fatalf("method = %q, want PROPFIND", r.Method)
		}
		if r.URL.Path != "/dav/" {
			t.Fatalf("path = %q, want /dav/", r.URL.Path)
		}
		if user, pass, ok := r.BasicAuth(); ok && (user != "user" || pass != "pass") {
			t.Fatalf("unexpected Basic Auth %q/%q", user, pass)
		}
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = w.Write([]byte(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`))
	}))
	defer server.Close()

	progress, err := NewPlaybackProgressStore(
		filepath.Join(t.TempDir(), "playback-progress.json"),
		24*time.Hour,
		1024*1024,
	)
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	service := &AppService{
		config:     diskConfig{},
		configPath: filepath.Join(t.TempDir(), "config.json"),
		proxy:      proxy,
		progress:   progress,
		httpClient: server.Client(),
	}
	defer service.close()

	state, err := service.AddWebDAVAccount(t.Context(), "家庭盘", server.URL+"/dav", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Accounts) != 1 || state.ActiveAccountID == "" {
		t.Fatalf("unexpected state after add: %+v", state)
	}
	accountID := state.ActiveAccountID
	if state.Accounts[0].ID != accountID || state.Accounts[0].Name != "家庭盘" {
		t.Fatalf("unexpected account after add: %+v", state.Accounts[0])
	}

	state, err = service.UpdateWebDAVAccount(t.Context(), accountID, "媒体盘", server.URL+"/dav/", "user", "pass")
	if err != nil {
		t.Fatal(err)
	}
	if state.ActiveAccountID != accountID || state.Accounts[0].Name != "媒体盘" || state.Accounts[0].Endpoint != server.URL+"/dav" {
		t.Fatalf("unexpected state after update: %+v", state)
	}

	if _, err := service.AddWebDAVAccount(t.Context(), "媒体盘", server.URL+"/dav", "", ""); err == nil {
		t.Fatal("expected duplicate WebDAV name to be rejected")
	}
	if got := len(service.GetState().Accounts); got != 1 {
		t.Fatalf("account count after duplicate add = %d, want 1", got)
	}
}
