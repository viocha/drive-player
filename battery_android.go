//go:build android

package main

// Android battery updates are delivered by the native Java bridge as
// player:BatteryChanged custom events. This keeps the shared service API buildable
// for the Android target; the player does not call it on Android.
func platformBatteryPercent() int {
	return -1
}
