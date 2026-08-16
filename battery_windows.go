//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

func platformBatteryPercent() int {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel32.NewProc("GetSystemPowerStatus")
	var status systemPowerStatus
	result, _, _ := proc.Call(uintptr(unsafe.Pointer(&status)))
	if result == 0 || status.BatteryLifePercent == 255 {
		return -1
	}
	percent := int(status.BatteryLifePercent)
	if percent < 0 || percent > 100 {
		return -1
	}
	return percent
}
