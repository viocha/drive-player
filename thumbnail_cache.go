package main

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxThumbnailPayloadBytes = 5 * 1024 * 1024

type ThumbnailResult struct {
	Found   bool   `json:"found"`
	DataURL string `json:"dataUrl"`
}

type ThumbnailCacheStats struct {
	Count      int   `json:"count"`
	TotalBytes int64 `json:"totalBytes"`
}

type ThumbnailCache struct {
	mu       sync.Mutex
	dir      string
	maxAge   time.Duration
	maxBytes int64
}

type thumbnailFile struct {
	path    string
	size    int64
	modTime time.Time
}

func NewThumbnailCache(dir string, maxAge time.Duration, maxBytes int64) (*ThumbnailCache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create thumbnail cache directory: %w", err)
	}
	cache := &ThumbnailCache{dir: dir, maxAge: maxAge, maxBytes: maxBytes}
	cache.mu.Lock()
	_, err := cache.pruneLocked(time.Now())
	cache.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return cache, nil
}

func (c *ThumbnailCache) SetLimits(maxAge time.Duration, maxBytes int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.maxAge = maxAge
	c.maxBytes = maxBytes
	_, err := c.pruneLocked(time.Now())
	return err
}

func (c *ThumbnailCache) Get(key string) (ThumbnailResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	for _, ext := range []string{".webp", ".jpg", ".png"} {
		filePath := filepath.Join(c.dir, key+ext)
		info, err := os.Stat(filePath)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return ThumbnailResult{}, fmt.Errorf("stat thumbnail: %w", err)
		}
		if c.maxAge > 0 && now.Sub(info.ModTime()) > c.maxAge {
			_ = os.Remove(filePath)
			continue
		}
		data, err := os.ReadFile(filePath)
		if err != nil {
			return ThumbnailResult{}, fmt.Errorf("read thumbnail: %w", err)
		}
		_ = os.Chtimes(filePath, now, now)
		mimeType := "image/webp"
		switch ext {
		case ".jpg":
			mimeType = "image/jpeg"
		case ".png":
			mimeType = "image/png"
		}
		return ThumbnailResult{Found: true, DataURL: "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)}, nil
	}
	return ThumbnailResult{Found: false}, nil
}

func (c *ThumbnailCache) Save(key, dataURL string) (ThumbnailCacheStats, error) {
	mimeType, data, err := decodeThumbnailDataURL(dataURL)
	if err != nil {
		return ThumbnailCacheStats{}, err
	}

	ext := ".webp"
	switch mimeType {
	case "image/webp":
	case "image/jpeg":
		ext = ".jpg"
	case "image/png":
		ext = ".png"
	default:
		return ThumbnailCacheStats{}, fmt.Errorf("unsupported thumbnail MIME type: %s", mimeType)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return ThumbnailCacheStats{}, fmt.Errorf("create thumbnail cache directory: %w", err)
	}
	for _, oldExt := range []string{".webp", ".jpg", ".png"} {
		if oldExt != ext {
			_ = os.Remove(filepath.Join(c.dir, key+oldExt))
		}
	}

	finalPath := filepath.Join(c.dir, key+ext)
	tmp, err := os.CreateTemp(c.dir, key+"-*.tmp")
	if err != nil {
		return ThumbnailCacheStats{}, fmt.Errorf("create thumbnail temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return ThumbnailCacheStats{}, fmt.Errorf("set thumbnail permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return ThumbnailCacheStats{}, fmt.Errorf("write thumbnail: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return ThumbnailCacheStats{}, fmt.Errorf("close thumbnail: %w", err)
	}
	_ = os.Remove(finalPath)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return ThumbnailCacheStats{}, fmt.Errorf("save thumbnail: %w", err)
	}
	now := time.Now()
	_ = os.Chtimes(finalPath, now, now)
	return c.pruneLocked(now)
}

func (c *ThumbnailCache) Stats() (ThumbnailCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pruneLocked(time.Now())
}

func (c *ThumbnailCache) Clear() (ThumbnailCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entries, err := os.ReadDir(c.dir)
	if errors.Is(err, os.ErrNotExist) {
		return ThumbnailCacheStats{}, nil
	}
	if err != nil {
		return ThumbnailCacheStats{}, fmt.Errorf("read thumbnail cache directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !isThumbnailCacheFile(entry.Name()) {
			continue
		}
		if err := os.Remove(filepath.Join(c.dir, entry.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			return ThumbnailCacheStats{}, fmt.Errorf("remove thumbnail cache file: %w", err)
		}
	}
	return ThumbnailCacheStats{}, nil
}

func (c *ThumbnailCache) pruneLocked(now time.Time) (ThumbnailCacheStats, error) {
	files, err := c.listFilesLocked()
	if err != nil {
		return ThumbnailCacheStats{}, err
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
	return ThumbnailCacheStats{Count: len(files), TotalBytes: total}, nil
}

func (c *ThumbnailCache) listFilesLocked() ([]thumbnailFile, error) {
	entries, err := os.ReadDir(c.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read thumbnail cache directory: %w", err)
	}
	files := make([]thumbnailFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !isThumbnailCacheFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, thumbnailFile{path: filepath.Join(c.dir, entry.Name()), size: info.Size(), modTime: info.ModTime()})
	}
	return files, nil
}

func decodeThumbnailDataURL(value string) (string, []byte, error) {
	header, payload, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:image/") || !strings.HasSuffix(header, ";base64") {
		return "", nil, errors.New("invalid thumbnail data URL")
	}
	mimeType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
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

func isThumbnailCacheFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".webp" || ext == ".jpg" || ext == ".png"
}

func thumbnailCacheKey(username, remotePath, modifiedAt string, offsetSeconds int) string {
	source := strings.Join([]string{strings.TrimSpace(username), normalizeRemotePath(remotePath), strings.TrimSpace(modifiedAt), fmt.Sprintf("offset=%d", offsetSeconds)}, "\n")
	return fmt.Sprintf("%x", sha256.Sum256([]byte(source)))
}
