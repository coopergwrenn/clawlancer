export interface ServerConfig {
  name: string;
  userData?: string;
}

export interface ServerResult {
  providerId: string;
  provider: "hetzner" | "digitalocean" | "linode";
  ip: string;
  name: string;
  region: string;
  serverType: string;
  status: string;
}

export interface CloudProvider {
  name: "hetzner" | "digitalocean" | "linode";
  createServer(config: ServerConfig): Promise<ServerResult>;
  waitForServer(providerId: string): Promise<ServerResult>;
  deleteServer(providerId: string): Promise<void>;
  rebootServer?(providerId: string): Promise<void>;
  isConfigured(): boolean;
}
