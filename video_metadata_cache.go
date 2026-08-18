package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxThumbnailPayloadBytes = 5 * 1024 * 1024

type VideoMetadataResult struct {
	Found            bool    `json:"found"`
	ThumbnailDataURL string  `json:"thumbnailDataUrl"`
	Width            int     `json:"width"`
	Height           int     `json:"height"`
	FrameRate        float64 `json:"frameRate"`
}

type VideoMetadataCacheStats struct {
	Count      int   `json:"count"`
	TotalBytes int64 `json:"totalBytes"`
}

type VideoMetadataCache struct {
	mu       sync.Mutex
	dir      string
	maxAge   time.Duration
	maxBytes int64
}

type videoMetadataCacheEntry struct {
	ThumbnailDataURL string  `json:"thumbnailDataUrl"`
	Width            int     `json:"width"`
	Height           int     `json:"height"`
	FrameRate        float64 `json:"frameRate"`
}

type videoMetadataFile struct {
	path    string
	size    int64
	modTime time.Time
}

func NewVideoMetadataCache(dir string, maxAge time.Duration, maxBytes int64) (*VideoMetadataCache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create video metadata cache directory: %w", err)
	}
	cache := &VideoMetadataCache{dir: dir, maxAge: maxAge, maxBytes: maxBytes}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if _, err := cache.pruneLocked(time.Now()); err != nil {
		return nil, err
	}
	return cache, nil
}

func (c *VideoMetadataCache) SetLimits(maxAge time.Duration, maxBytes int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.maxAge = maxAge
	c.maxBytes = maxBytes
	_, err := c.pruneLocked(time.Now())
	return err
}

func (c *VideoMetadataCache) Get(key string) (VideoMetadataResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	filePath := filepath.Join(c.dir, key+".json")
	info, err := os.Stat(filePath)
	if errors.Is(err, os.ErrNotExist) {
		return VideoMetadataResult{Found: false}, nil
	}
	if err != nil {
		return VideoMetadataResult{}, fmt.Errorf("stat video metadata: %w", err)
	}
	if c.maxAge > 0 && now.Sub(info.ModTime()) > c.maxAge {
		_ = os.Remove(filePath)
		return VideoMetadataResult{Found: false}, nil
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return VideoMetadataResult{}, fmt.Errorf("read video metadata: %w", err)
	}
	var entry videoMetadataCacheEntry
	if err := json.Unmarshal(data, &entry); err != nil || validateVideoMetadataCacheEntry(entry) != nil {
		_ = os.Remove(filePath)
		return VideoMetadataResult{Found: false}, nil
	}
	_ = os.Chtimes(filePath, now, now)
	return VideoMetadataResult{
		Found:            true,
		ThumbnailDataURL: entry.ThumbnailDataURL,
		Width:            entry.Width,
		Height:           entry.Height,
		FrameRate:        entry.FrameRate,
	}, nil
}

func (c *VideoMetadataCache) Save(key, thumbnailDataURL string, width, height int, frameRate float64) (VideoMetadataCacheStats, error) {
	entry := videoMetadataCacheEntry{
		ThumbnailDataURL: thumbnailDataURL,
		Width:            width,
		Height:           height,
		FrameRate:        frameRate,
	}
	if err := validateVideoMetadataCacheEntry(entry); err != nil {
		return VideoMetadataCacheStats{}, err
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return VideoMetadataCacheStats{}, fmt.Errorf("encode video metadata cache entry: %w", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return VideoMetadataCacheStats{}, fmt.Errorf("create video metadata cache directory: %w", err)
	}
	finalPath := filepath.Join(c.dir, key+".json")
	tmp, err := os.CreateTemp(c.dir, key+"-*.tmp")
	if err != nil {
		return VideoMetadataCacheStats{}, fmt.Errorf("create video metadata temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return VideoMetadataCacheStats{}, fmt.Errorf("set video metadata permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return VideoMetadataCacheStats{}, fmt.Errorf("write video metadata: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return VideoMetadataCacheStats{}, fmt.Errorf("close video metadata: %w", err)
	}
	_ = os.Remove(finalPath)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return VideoMetadataCacheStats{}, fmt.Errorf("save video metadata: %w", err)
	}
	now := time.Now()
	_ = os.Chtimes(finalPath, now, now)
	return c.pruneLocked(now)
}

func (c *VideoMetadataCache) Stats() (VideoMetadataCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pruneLocked(time.Now())
}

func (c *VideoMetadataCache) Clear() (VideoMetadataCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entries, err := os.ReadDir(c.dir)
	if errors.Is(err, os.ErrNotExist) {
		return VideoMetadataCacheStats{}, nil
	}
	if err != nil {
		return VideoMetadataCacheStats{}, fmt.Errorf("read video metadata cache directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if err := os.Remove(filepath.Join(c.dir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return VideoMetadataCacheStats{}, fmt.Errorf("remove video metadata cache file: %w", err)
		}
	}
	return VideoMetadataCacheStats{}, nil
}

func (c *VideoMetadataCache) pruneLocked(now time.Time) (VideoMetadataCacheStats, error) {
	files, err := c.listFilesLocked()
	if err != nil {
		return VideoMetadataCacheStats{}, err
	}

	kept := files[:0]
	for _, file := range files {
		if c.maxAge > 0 && now.Sub(file.modTime) > c.maxAge {
			_ = os.Remove(file.path)
			continue
		}
		kept = append(kept, file)
	}
	files = kept

	sort.Slice(files, func(i, j int) bool { return files[i].modTime.Before(files[j].modTime) })
	var total int64
	for _, file := range files {
		total += file.size
	}
	for c.maxBytes > 0 && total > c.maxBytes && len(files) > 0 {
		oldest := files[0]
		files = files[1:]
		if err := os.Remove(oldest.path); err == nil || errors.Is(err, os.ErrNotExist) {
			total -= oldest.size
		}
	}
	return VideoMetadataCacheStats{Count: len(files), TotalBytes: total}, nil
}

func (c *VideoMetadataCache) listFilesLocked() ([]videoMetadataFile, error) {
	entries, err := os.ReadDir(c.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read video metadata cache directory: %w", err)
	}
	files := make([]videoMetadataFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !isVideoMetadataCacheFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, videoMetadataFile{path: filepath.Join(c.dir, entry.Name()), size: info.Size(), modTime: info.ModTime()})
	}
	return files, nil
}

func validateVideoMetadataCacheEntry(entry videoMetadataCacheEntry) error {
	if _, _, err := decodeThumbnailDataURL(entry.ThumbnailDataURL); err != nil {
		return err
	}
	if entry.Width <= 0 || entry.Height <= 0 {
		return errors.New("video metadata dimensions must be positive")
	}
	if math.IsNaN(entry.FrameRate) || math.IsInf(entry.FrameRate, 0) || entry.FrameRate <= 0 {
		return errors.New("video metadata frame rate must be positive")
	}
	return nil
}

func decodeThumbnailDataURL(value string) (string, []byte, error) {
	header, payload, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:image/") || !strings.HasSuffix(header, ";base64") {
		return "", nil, errors.New("invalid thumbnail data URL")
	}
	mimeType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	switch mimeType {
	case "image/webp", "image/jpeg", "image/png":
	default:
		return "", nil, fmt.Errorf("unsupported thumbnail MIME type: %s", mimeType)
	}
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "", nil, errors.New("invalid thumbnail base64 data")
	}
	if len(data) == 0 {
		return "", nil, errors.New("thumbnail is empty")
	}
	if len(data) > maxThumbnailPayloadBytes {
		return "", nil, fmt.Errorf("thumbnail exceeds %d bytes", maxThumbnailPayloadBytes)
	}
	return mimeType, data, nil
}

func isVideoMetadataCacheFile(name string) bool {
	return strings.EqualFold(filepath.Ext(name), ".json")
}

func videoMetadataCacheKey(username, remotePath, modifiedAt string, offsetPercent int) string {
	source := strings.Join([]string{strings.TrimSpace(username), normalizeRemotePath(remotePath), strings.TrimSpace(modifiedAt), fmt.Sprintf("offsetPercent=%d", offsetPercent)}, "\n")
	return fmt.Sprintf("%x", sha256.Sum256([]byte(source)))
}
