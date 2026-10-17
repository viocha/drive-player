package main

import "context"

type VideoPreview struct {
	Path     string              `json:"path"`
	Metadata VideoMetadataResult `json:"metadata"`
	Cover    string              `json:"cover"`
}

// GetVideoPreviews 只批量读取本地缓存，不触发远程分析或截图。
func (s *AppService) GetVideoPreviews(ctx context.Context, entries []FileEntry) ([]VideoPreview, error) {
	accountKey, err := s.currentAccountKey()
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	offset := s.config.VideoMetadataThumbnailOffsetPercent
	s.mu.RUnlock()
	result := make([]VideoPreview, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		metadata, _ := s.videoMetadata.Get(videoMetadataCacheKey(accountKey, entry.Path, entry.ModifiedAt, videoMetadataCacheOffsetPercent))
		cover := ""
		name, err := s.videoSnapshots.GetCover(videoMetadataCacheKey(accountKey, entry.Path, entry.ModifiedAt, offset))
		if err == nil && name != "" {
			cover = s.proxy.VideoSnapshotURL(name)
		}
		result = append(result, VideoPreview{Path: entry.Path, Metadata: metadata, Cover: cover})
	}
	return result, nil
}
