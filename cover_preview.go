package main

import "errors"

func validCoverPreviewWidth(width int) bool {
	return width == 0 || width == 320 || width == 480 || width == 640
}

func (s *AppService) SetCoverPreviewDelay(delayMS int) (AppState, error) {
	if delayMS < 0 || delayMS > 5000 {
		return AppState{}, errors.New("封面预览延迟必须在 0 到 5000 毫秒之间")
	}
	s.mu.Lock()
	previous := s.config
	s.config.CoverPreviewDelayMS = delayMS
	config := s.config
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) SetCoverPreviewWidth(width int) (AppState, error) {
	if !validCoverPreviewWidth(width) {
		return AppState{}, errors.New("封面预览宽度必须为 0、320、480 或 640")
	}
	s.mu.Lock()
	previous := s.config
	s.config.CoverPreviewWidth = width
	config := s.config
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	return s.GetState(), nil
}
