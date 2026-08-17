package main

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestVideoSnapshotCacheSeriesAndClear(t *testing.T) {
	cache, err := NewVideoSnapshotCache(t.TempDir(), 24*time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	pngData := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngData)

	if _, err := cache.Save("video-a", 10.25, dataURL); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Save("video-a", 20.5, dataURL); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Save("video-b", 5, dataURL); err != nil {
		t.Fatal(err)
	}

	series, err := cache.GetSeries("video-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(series) != 2 || series[0].Position != 10.25 || series[1].Position != 20.5 {
		t.Fatalf("unexpected series: %#v", series)
	}
	if series[0].FileName == "" || series[1].FileName == "" {
		t.Fatalf("expected snapshot filenames, got %#v", series)
	}

	stats, err := cache.ClearSeries("video-a")
	if err != nil {
		t.Fatal(err)
	}
	if stats.Count != 1 {
		t.Fatalf("expected one snapshot after series clear, got %#v", stats)
	}
	stats, err = cache.Clear()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Count != 0 || stats.TotalBytes != 0 {
		t.Fatalf("expected empty cache, got %#v", stats)
	}
}
