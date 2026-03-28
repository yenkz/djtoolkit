export interface AppConfig {
  downloads_dir: string;
  launch_at_startup: boolean;
  api_key: string;
  slsk_username: string;
  poll_interval_sec: number;
  max_concurrent_jobs: number;
}

export type DaemonStatus = "stopped" | "starting" | "running" | "paused";

export interface WizardData {
  apiKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  agentEmail: string;
  agentPassword: string;
  slskUsername: string;
  slskPassword: string;
  launchAtStartup: boolean;
}
