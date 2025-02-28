import { load } from "@fingerprintjs/fingerprintjs";

export class Fingerprint {
  static async getVisitorId(): Promise<string> {
    const fp = await load();
    const { visitorId } = await fp.get();
    return visitorId;
  }
}
