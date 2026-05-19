/**
 * Ambient declaration for ssh2 — the project doesn't install @types/ssh2,
 * and most consumers are in scripts/ (which tsconfig excludes). The bake
 * modules live under lib/ (included by tsconfig), so we need to declare
 * the surface area we use.
 *
 * Keep this minimal — just the methods and event shapes the bake actually
 * calls. If a future bake module needs more, extend here.
 */

declare module "ssh2" {
  // Minimal Client surface — matches what we use in linode-api.ts,
  // verifications.ts, strip-bearer.ts, and steps.ts. We type values
  // pragmatically as `any` since the upstream library has no types.
  export class Client {
    on(event: "ready", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    connect(config: {
      host: string;
      port: number;
      username: string;
      privateKey: string | Buffer;
      readyTimeout?: number;
      [k: string]: any;
    }): this;
    exec(
      cmd: string,
      callback: (err: Error | undefined, stream: any) => void,
    ): this;
    sftp(callback: (err: Error | undefined, sftp: any) => void): this;
    end(): this;
  }
}
