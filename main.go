package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	service, err := NewAppService()
	if err != nil {
		log.Fatal(err)
	}
	defer service.close()

	var mainWindow *application.WebviewWindow
	app := application.New(application.Options{
		Name:        "Drive Player",
		Description: "Cloud drive video player",
		Windows:     platformWindowsOptions(),
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.drive-player.webdav",
			OnSecondInstanceLaunch: func(_ application.SecondInstanceData) {
				if mainWindow != nil {
					mainWindow.Restore()
					mainWindow.Focus()
				}
			},
		},
		Services: []application.Service{
			application.NewService(service),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "Drive Player",
		Width:     1280,
		Height:    800,
		MinWidth:  960,
		MinHeight: 640,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(248, 250, 252),
		URL:              "/",
	})
	unregisterBatteryEvents := registerPlatformBatteryEvents(app, mainWindow)
	defer unregisterBatteryEvents()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
