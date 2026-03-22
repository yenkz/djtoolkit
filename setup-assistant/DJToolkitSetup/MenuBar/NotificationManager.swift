import UserNotifications

enum NotificationManager {
    private static let center = UNUserNotificationCenter.current()

    /// Request notification permission (call once on tray launch)
    static func requestAuthorization() {
        center.requestAuthorization(options: [.alert]) { _, _ in }
    }

    /// Send an update-available notification
    static func sendUpdateNotification(version: String) {
        let content = UNMutableNotificationContent()
        content.title = "djtoolkit Update Available"
        content.body = "Version \(version) is ready to install."
        content.categoryIdentifier = "UPDATE"

        let request = UNNotificationRequest(
            identifier: "update-\(version)",
            content: content,
            trigger: nil // deliver immediately
        )
        center.add(request)
    }
}
