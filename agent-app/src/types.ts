export interface AppConfig {
  cloud_url: string;
  poll_interval_sec: number;
  max_concurrent_jobs: number;
  downloads_dir: string;
  launch_at_startup: boolean;
  slsk_username: string;
  slsk_password: string;
  acoustid_api_key: string;
  api_key: string;
}

export type DaemonStatus = "stopped" | "starting" | "running" | "paused";

export interface WizardData {
  apiKey: string;
  slskUsername: string;
  slskPassword: string;
  launchAtStartup: boolean;
}
