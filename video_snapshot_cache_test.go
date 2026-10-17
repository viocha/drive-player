package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestVideoKeyframeCacheSharesCoverAndSnapshotLimits(t *testing.T) {
	dir := t.TempDir()
	cache, err := NewVideoSnapshotCache(dir, 24*time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	_, cover, err := decodeThumbnailDataURL(tinyThumbnailDataURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cache.SaveCover("cover-key", tinyThumbnailDataURL); err != nil {
		t.Fatal(err)
	}
	coverName, err := cache.GetCover("cover-key")
	if err != nil || coverName == "" {
		t.Fatalf("封面未保存: %q %v", coverName, err)
	}
	if _, err := cache.Save("video-key", 10, 10, tinyThumbnailDataURL); err != nil {
		t.Fatal(err)
	}
	stats, err := cache.Stats()
	if err != nil || stats.Count != 2 || stats.TotalBytes != int64(2*len(cover)) {
		t.Fatalf("封面与截图应合并统计: %+v %v", stats, err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(dir, coverName), old, old); err != nil {
		t.Fatal(err)
	}
	if err := cache.SetLimits(24*time.Hour, int64(len(cover))); err != nil {
		t.Fatal(err)
	}
	if name, _ := cache.GetCover("cover-key"); name != "" {
		t.Fatal("容量限制应淘汰较早封面")
	}
	series, err := cache.GetSeries("video-key")
	if err != nil || len(series) != 1 {
		t.Fatalf("截图应保留: %+v %v", series, err)
	}
	if _, err := cache.SaveCover("cover-key", tinyThumbnailDataURL); err != nil {
		t.Fatal(err)
	}
	name, _ := cache.GetCover("cover-key")
	if err := os.Chtimes(filepath.Join(dir, name), time.Now().Add(-48*time.Hour), time.Now().Add(-48*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if name, err := cache.GetCover("cover-key"); err != nil || name != "" {
		t.Fatalf("封面应过期: %q %v", name, err)
	}
}

func TestVideoSnapshotCacheSeriesAndClear(t *testing.T) {
	cache, err := NewVideoSnapshotCache(t.TempDir(), 24*time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	pngData := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngData)

	if _, err := cache.Save("video-a", 10.25, 10.25, dataURL); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Save("video-a", 20.5, 20.5, dataURL); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Save("video-b", 5, 5, dataURL); err != nil {
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

func TestVideoSnapshotCacheStoresRequestedAndActualPosition(t *testing.T) {
	cache, err := NewVideoSnapshotCache(t.TempDir(), 24*time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Save("video", 10, 8, tinyThumbnailDataURL); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Save("video", 10, 12, tinyThumbnailDataURL); err != nil {
		t.Fatal(err)
	}
	series, err := cache.GetSeries("video")
	if err != nil || len(series) != 1 || series[0].RequestedPosition != 10 || series[0].Position != 12 {
		t.Fatalf("目标时间应保持稳定，并替换实际取帧位置: %+v %v", series, err)
	}
	stats, err := cache.Stats()
	if err != nil || stats.Count != 1 {
		t.Fatalf("同一目标只能保留一张截图: %+v %v", stats, err)
	}
}

func TestVideoSnapshotCacheMigratesSingleTimestampOnce(t *testing.T) {
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "video--000000010250.png")
	if err := os.WriteFile(oldPath, []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(oldPath, time.Now().Add(-time.Hour), time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		cache, err := NewVideoSnapshotCache(dir, 24*time.Hour, 1024*1024)
		if err != nil {
			t.Fatal(err)
		}
		series, err := cache.GetSeries("video")
		if err != nil || len(series) != 1 || series[0].Position != 10.25 || series[0].RequestedPosition != 10.25 {
			t.Fatalf("单时间戳迁移结果错误: %+v %v", series, err)
		}
		after, err := os.Stat(filepath.Join(dir, series[0].FileName))
		if err != nil || !after.ModTime().Equal(before.ModTime()) {
			t.Fatalf("迁移应保留修改时间: %v", err)
		}
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("迁移应完成文件重命名: %v", err)
	}
}
