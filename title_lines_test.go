package main

import "testing"

func TestTitleLinesSettingsPersistAndRollback(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	service, err := NewAppService()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.close() })
	if service.GetState().TitleLines != 1 {
		t.Fatal("标题默认显示一行")
	}
	if state, err := service.SetTitleLines(3); err != nil || state.TitleLines != 3 {
		t.Fatalf("保存标题行数失败：%v", err)
	}
	restarted, err := NewAppService()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.close() })
	if restarted.GetState().TitleLines != 3 {
		t.Fatal("重启后应保留标题行数")
	}
	for _, lines := range []int{0, 4} {
		if _, err := restarted.SetTitleLines(lines); err == nil {
			t.Fatal("只能配置一到三行")
		}
	}
	restarted.configPath = t.TempDir()
	if _, err := restarted.SetTitleLines(2); err == nil || restarted.GetState().TitleLines != 3 {
		t.Fatal("保存失败时应保留已保存的行数")
	}
}
