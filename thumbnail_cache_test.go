package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const tinyPNGDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

func TestThumbnailCacheSaveGetExpireAndClear(t *testing.T) {
	dir := t.TempDir()
	cache, err := NewThumbnailCache(dir, 24*time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}

	key := thumbnailCacheKey("user", "/video.mp4", "2026-08-15T00:00:00Z", 5)
	stats, err := cache.Save(key, tinyPNGDataURL)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Count != 1 || stats.TotalBytes <= 0 {
		t.Fatalf("unexpected stats after save: %+v", stats)
	}

	result, err := cache.Get(key)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Found || result.DataURL == "" {
		t.Fatalf("expected cached thumbnail, got %+v", result)
	}

	filePath := filepath.Join(dir, key+".png")
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(filePath, old, old); err != nil {
		t.Fatal(err)
	}
	result, err = cache.Get(key)
	if err != nil {
		t.Fatal(err)
	}
	if result.Found {
		t.Fatal("expected expired thumbnail to be removed")
	}

	if _, err := cache.Save(key, tinyPNGDataURL); err != nil {
		t.Fatal(err)
	}
	stats, err = cache.Clear()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Count != 0 || stats.TotalBytes != 0 {
		t.Fatalf("unexpected stats after clear: %+v", stats)
	}
}
