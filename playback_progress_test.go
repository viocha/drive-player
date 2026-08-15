package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPlaybackProgressSaveGetRetainsExactPosition(t *testing.T) {
	store, err := NewPlaybackProgressStore(filepath.Join(t.TempDir(), "progress.json"), 365*24*time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save("user", "/video.mp4", 120, 1000); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get("user", "/video.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Found || got.Position != 120 {
		t.Fatalf("unexpected progress: %+v", got)
	}
	if _, err := store.Save("user", "/video.mp4", 0, 1000); err != nil {
		t.Fatal(err)
	}
	got, err = store.Get("user", "/video.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Found || got.Position != 0 {
		t.Fatalf("zero position should be retained: %+v", got)
	}
	if _, err := store.Save("user", "/video.mp4", 990, 1000); err != nil {
		t.Fatal(err)
	}
	got, err = store.Get("user", "/video.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Found || got.Position != 990 {
		t.Fatalf("near-end position should be retained: %+v", got)
	}
	if _, err := store.Save("user", "/video.mp4", 1000, 1000); err != nil {
		t.Fatal(err)
	}
	got, err = store.Get("user", "/video.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if got.Found {
		t.Fatalf("ended position should be removed: %+v", got)
	}
}

func TestPlaybackProgressGetRemovesPreviouslyStoredCompletedPosition(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "progress.json")
	store, err := NewPlaybackProgressStore(filePath, 365*24*time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	key := playbackProgressKey("user", "/video.mp4")
	store.entries[key] = playbackProgressRecord{
		Username:  "user",
		Path:      "/video.mp4",
		Position:  1000,
		Duration:  1000,
		UpdatedAt: time.Now(),
	}
	if err := store.persistLocked(); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()

	got, err := store.Get("user", "/video.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if got.Found {
		t.Fatalf("completed stored progress should be removed on read: %+v", got)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("expected completed-only progress file removed, stat err=%v", err)
	}
}

func TestPlaybackProgressPrunesExpired(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "progress.json")
	store, err := NewPlaybackProgressStore(filePath, time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Save("user", "/video.mp4", 120, 1000); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	key := playbackProgressKey("user", "/video.mp4")
	record := store.entries[key]
	record.UpdatedAt = time.Now().Add(-2 * time.Hour)
	store.entries[key] = record
	if err := store.persistLocked(); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()

	stats, err := store.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Count != 0 {
		t.Fatalf("expected expired progress to be pruned, got %+v", stats)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("expected empty progress file removed, stat err=%v", err)
	}
}
