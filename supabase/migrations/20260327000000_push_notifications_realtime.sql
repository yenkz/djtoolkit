-- Enable Realtime for push_notifications so the notification bell
-- and notifications page receive live updates via WebSocket.
ALTER PUBLICATION supabase_realtime ADD TABLE push_notifications;
