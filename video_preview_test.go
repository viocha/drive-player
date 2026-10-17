package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestVideoPreviewBatchRestoresCachesAcrossMissingAndBrokenItems(t *testing.T) {
	service := newMultiAccountTestService(t)
	var err error
	service.videoMetadata, err = NewVideoMetadataCache(t.TempDir(), time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	service.videoSnapshots, err = NewVideoSnapshotCache(t.TempDir(), time.Hour, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	entries := []FileEntry{{Path: "/first.mp4"}, {Path: "/missing.mp4"}, {Path: "/broken.mp4"}, {Path: "/last.mp4"}}
	for i, entry := range entries {
		key := videoMetadataCacheKey("account-a", entry.Path, entry.ModifiedAt, videoMetadataCacheOffsetPercent)
		if _, err := service.videoMetadata.Save(key, 1920, 1080, 24); err != nil {
			t.Fatal(err)
		}
		if i != 1 {
			coverKey := videoMetadataCacheKey("account-a", entry.Path, entry.ModifiedAt, service.config.VideoMetadataThumbnailOffsetPercent)
			if _, err := service.videoSnapshots.SaveCover(coverKey, tinyThumbnailDataURL); err != nil {
				t.Fatal(err)
			}
		}
		if i == 2 {
			name := filepath.Join(service.videoMetadata.dir, key+".json")
			if err := os.Remove(name); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(name, 0700); err != nil {
				t.Fatal(err)
			}
		}
	}
	result, err := service.GetVideoPreviews(t.Context(), entries)
	if err != nil || len(result) != len(entries) {
		t.Fatalf("批量读取失败：%v %v", result, err)
	}
	for i, preview := range result {
		if preview.Path != entries[i].Path || (preview.Cover != "") != (i != 1) || preview.Metadata.Found != (i != 2) {
			t.Fatalf("第 %d 项缓存错误：%+v", i, preview)
		}
	}
	if _, err := service.SwitchWebDAVAccount("account-b"); err != nil {
		t.Fatal(err)
	}
	isolated, err := service.GetVideoPreviews(t.Context(), entries)
	if err != nil {
		t.Fatal(err)
	}
	for _, preview := range isolated {
		if preview.Cover != "" || preview.Metadata.Found {
			t.Fatal("缓存不能跨账户混用")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := service.GetVideoPreviews(ctx, entries); err != context.Canceled {
		t.Fatalf("读取未响应取消：%v", err)
	}
}
