import { expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateHarness } from "./harness.ts";

it("bootstrap installs flat and nested cached plugins, including incomplete installs", async () => {
  const h = gateHarness();
  const cache = join(h.root, "cache with ' quote");
  const flat = join(cache, "market___tool-gate___test");
  const nested = join(cache, "legacy/version");
  const noDeps = join(cache, "without-dependencies");
  const bin = join(h.root, "bin");
  mkdirSync(bin);
  for (const dir of [flat, nested, noDeps]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(dir === noDeps ? {} : { dependencies: { "synthetic-package": "1.0.0" } }));
  }
  mkdirSync(join(flat, "node_modules"));
  // Stub installer: the harness never installs packages or accesses a registry.
  const stub = join(bin, "bun");
  writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD|$*" >> "$OMP_TEST_INSTALL_LOG"\n');
  chmodSync(stub, 0o700);
  const log = join(h.root, "install.log");
  const child = Bun.spawn(["bash", `${import.meta.dir}/../../../scripts/install-omp-plugin-deps.sh`, cache], {
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, OMP_TEST_INSTALL_LOG: log }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  const installs = readFileSync(log, "utf8").trim().split("\n");
  expect(installs).toHaveLength(2);
  expect(installs.some(line => line.endsWith("market___tool-gate___test|install --production"))).toBe(true);
  expect(installs.some(line => line.endsWith("legacy/version|install --production"))).toBe(true);
});

it("bootstrap dependency dry-run does not invoke the installer", async () => {
  const h = gateHarness();
  const cache = join(h.root, "cache");
  const plugin = join(cache, "test-plugin");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ dependencies: { synthetic: "1" } }));
  const child = Bun.spawn(["bash", `${import.meta.dir}/../../../scripts/install-omp-plugin-deps.sh`, cache, "--dry-run"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output).toContain("would install");
  expect(existsSync(join(plugin, "node_modules"))).toBe(false);
});
