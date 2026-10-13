package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const tinyThumbnailDataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

func TestVideoMetadataCacheSaveGetExpireAndClear(t *testing.T) {
	dir := t.TempDir()
	cache, err := NewVideoMetadataCache(dir, 24*time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}

	key := videoMetadataCacheKey("user", "/video.mp4", "2026-08-15T00:00:00Z", 5)
	stats, err := cache.Save(key, 1920, 1080, 23.976)
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
	if !result.Found || result.Width != 1920 || result.Height != 1080 || result.FrameRate != 23.976 {
		t.Fatalf("expected cached video metadata, got %+v", result)
	}

	filePath := filepath.Join(dir, key+".json")
	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 3 {
		t.Fatalf("元信息仅包含尺寸、帧率: %s", data)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(filePath, old, old); err != nil {
		t.Fatal(err)
	}
	result, err = cache.Get(key)
	if err != nil {
		t.Fatal(err)
	}
	if result.Found {
		t.Fatal("expected expired video metadata to be removed")
	}

	if _, err := cache.Save(key, 1920, 1080, 23.976); err != nil {
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
