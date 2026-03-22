import ServiceManagement

enum LoginItemManager {
    /// Whether the app is registered as a login item.
    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    /// Register the app to launch at login.
    static func enable() throws {
        try SMAppService.mainApp.register()
    }

    /// Unregister the app from launching at login.
    static func disable() {
        // unregister can throw but we don't need to surface errors for disable
        try? SMAppService.mainApp.unregister()
    }
}
