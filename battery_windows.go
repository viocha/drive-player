//go:build windows

package main

import (
	"sync"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const deviceNotifyWindowHandle = 0

type windowsGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var batteryPercentageRemainingGUID = windowsGUID{
	Data1: 0xA7AD8041,
	Data2: 0xB45A,
	Data3: 0x4CAE,
	Data4: [8]byte{0x87, 0xA3, 0xEE, 0xCB, 0xB4, 0x68, 0xA9, 0xE1},
}

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

func registerPlatformBatteryEvents(app *application.App, mainWindow *application.WebviewWindow) func() {
	emitBatteryChanged := func(_ *application.ApplicationEvent) {
		app.Event.Emit("player:BatteryChanged")
	}

	removePowerStatusListener := app.Event.OnApplicationEvent(events.Windows.APMPowerStatusChange, emitBatteryChanged)
	removePowerSettingListener := app.Event.OnApplicationEvent(events.Windows.APMPowerSettingChange, emitBatteryChanged)
	removeResumeListener := app.Event.OnApplicationEvent(events.Windows.APMResumeAutomatic, emitBatteryChanged)

	user32 := syscall.NewLazyDLL("user32.dll")
	registerPowerSettingNotification := user32.NewProc("RegisterPowerSettingNotification")
	unregisterPowerSettingNotification := user32.NewProc("UnregisterPowerSettingNotification")

	var mu sync.Mutex
	var notificationHandle uintptr
	unregisterNotification := func() {
		mu.Lock()
		defer mu.Unlock()
		if notificationHandle == 0 {
			return
		}
		unregisterPowerSettingNotification.Call(notificationHandle)
		notificationHandle = 0
	}

	removeRuntimeReadyListener := mainWindow.OnWindowEvent(events.Common.WindowRuntimeReady, func(_ *application.WindowEvent) {
		hwnd := mainWindow.NativeWindow()
		if hwnd == nil {
			return
		}

		mu.Lock()
		defer mu.Unlock()
		if notificationHandle != 0 {
			return
		}

		handle, _, _ := registerPowerSettingNotification.Call(
			uintptr(hwnd),
			uintptr(unsafe.Pointer(&batteryPercentageRemainingGUID)),
			deviceNotifyWindowHandle,
		)
		notificationHandle = handle
	})
	removeWindowClosingListener := mainWindow.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		unregisterNotification()
	})

	return func() {
		removeRuntimeReadyListener()
		removeWindowClosingListener()
		removePowerStatusListener()
		removePowerSettingListener()
		removeResumeListener()
		unregisterNotification()
	}
}
