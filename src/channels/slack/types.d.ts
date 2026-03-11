// Type stubs for optional @slack/bolt dependency.
// At runtime, the actual package is loaded via dynamic import().
declare module '@slack/bolt' {
  export class App {
    constructor(opts: {
      token: string;
      appToken: string;
      socketMode: boolean;
      logLevel?: string;
    });
    client: {
      auth: { test(opts: { token: string }): Promise<{ user_id: string; user: string }> };
      chat: {
        postMessage(opts: any): Promise<{ ts: string }>;
        update(opts: any): Promise<any>;
        delete(opts: any): Promise<any>;
      };
      reactions: {
        add(opts: any): Promise<any>;
      };
      files: {
        info(opts: any): Promise<{ file?: { url_private_download?: string; url_private?: string } }>;
        uploadV2(opts: any): Promise<{ file?: { shares?: { public?: any; private?: any } } }>;
      };
      conversations: {
        list(opts: any): Promise<{ channels?: any[] }>;
      };
    };
    message(handler: (args: any) => Promise<void>): void;
    event(name: string, handler: (args: any) => Promise<void>): void;
    start(): Promise<void>;
    stop(): Promise<void>;
  }
}
