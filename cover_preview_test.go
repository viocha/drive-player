package main

import "testing"

func TestCoverPreviewWidthPersistsAndRollsBack(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	service, err := NewAppService()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.close() })
	if service.GetState().CoverPreviewWidth != 480 {
		t.Fatal("封面预览默认宽度应为 480")
	}
	for _, width := range []int{320, 640, 0} {
		if state, err := service.SetCoverPreviewWidth(width); err != nil || state.CoverPreviewWidth != width {
			t.Fatalf("保存预览宽度失败：%v", err)
		}
	}
	restarted, err := NewAppService()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.close() })
	if restarted.GetState().CoverPreviewWidth != 0 {
		t.Fatal("重启后应保留关闭预览的设置")
	}
	if _, err := restarted.SetCoverPreviewWidth(100); err == nil {
		t.Fatal("不应保存无效的预览宽度")
	}
	restarted.configPath = t.TempDir()
	if _, err := restarted.SetCoverPreviewWidth(480); err == nil || restarted.GetState().CoverPreviewWidth != 0 {
		t.Fatal("保存失败应恢复设置")
	}
}

func TestCoverPreviewDelayPersistsAndRollsBack(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	service, err := NewAppService()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.close() })
	if service.GetState().CoverPreviewDelayMS != 0 {
		t.Fatal("封面预览默认无延迟")
	}
	for _, delay := range []int{5000, 123, 0, 150} {
		state, err := service.SetCoverPreviewDelay(delay)
		if err != nil || state.CoverPreviewDelayMS != delay {
			t.Fatalf("保存延迟失败：%v", err)
		}
	}
	restarted, err := NewAppService()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.close() })
	if restarted.GetState().CoverPreviewDelayMS != 150 {
		t.Fatal("重启后应保留预览延迟")
	}
	for _, invalid := range []int{-1, 5001} {
		if _, err := restarted.SetCoverPreviewDelay(invalid); err == nil {
			t.Fatal("不应保存无效延迟")
		}
	}
	restarted.configPath = t.TempDir()
	if _, err := restarted.SetCoverPreviewDelay(0); err == nil || restarted.GetState().CoverPreviewDelayMS != 150 {
		t.Fatal("保存失败应恢复延迟设置")
	}
}
