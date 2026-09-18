// Minimal Marionette client for driving a test Firefox in chrome context.
// Usage: node marionette.js <port> <scriptfile>   (scriptfile exports async (m) => {...})
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

class Marionette {
  constructor(port) {
    this.port = port;
    this.id = 0;
    this.pending = new Map();
    this.buf = "";
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, "127.0.0.1");
      this.sock.setEncoding("utf8");
      let hello = false;
      this.sock.on("data", chunk => {
        this.buf += chunk;
        for (;;) {
          const m = /^(\d+):/.exec(this.buf);
          if (!m) break;
          const len = +m[1];
          const start = m[0].length;
          if (Buffer.byteLength(this.buf.slice(start)) < len) break;
          // slice by bytes
          const bytes = Buffer.from(this.buf.slice(start));
          const body = bytes.subarray(0, len).toString("utf8");
          this.buf = bytes.subarray(len).toString("utf8");
          const msg = JSON.parse(body);
          if (!hello) {
            hello = true;
            resolve(msg);
            continue;
          }
          const [type, id, err, res] = msg;
          const p = this.pending.get(id);
          if (!p) continue;
          this.pending.delete(id);
          if (err) p.reject(new Error(JSON.stringify(err))); else p.resolve(res);
        }
      });
      this.sock.on("error", reject);
    });
  }
  send(name, params = {}) {
    const id = ++this.id;
    const body = JSON.stringify([0, id, name, params]);
    this.sock.write(Buffer.byteLength(body) + ":" + body);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async newSession() {
    await this.send("WebDriver:NewSession", { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
    await this.send("Marionette:SetContext", { value: "chrome" });
  }
  async exec(script, args = []) {
    const r = await this.send("WebDriver:ExecuteScript", { script, args, sandbox: null, newSandbox: false });
    return r.value;
  }
  async execAsync(script, args = []) {
    const r = await this.send("WebDriver:ExecuteAsyncScript", { script, args, sandbox: null, newSandbox: false });
    return r.value;
  }
  async screenshot(file) {
    const r = await this.send("WebDriver:TakeScreenshot", { full: false, hash: false });
    fs.writeFileSync(file, Buffer.from(r.value, "base64"));
    return file;
  }
  close() {
    this.sock.destroy();
  }
}

(async () => {
  const port = +process.argv[2] || 2829;
  const file = process.argv[3];
  const m = new Marionette(port);
  const hello = await m.connect();
  console.log("connected:", JSON.stringify(hello));
  await m.newSession();
  try {
    const fn = require(path.resolve(file));
    await fn(m);
  } catch (e) {
    console.error("FAILED:", e);
    process.exitCode = 1;
  } finally {
    m.close();
  }
})();
