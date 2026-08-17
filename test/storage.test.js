import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.js";

test("JSON store serializes concurrent transactions without lost updates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "payment-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "database.json");
  const store = await new JsonStore(file).init();
  await store.transaction((database) => { database.counter = 0; });
  await Promise.all(Array.from({ length: 20 }, () => store.transaction(async (database) => {
    const value = database.counter;
    await Promise.resolve();
    database.counter = value + 1;
  })));
  assert.equal(store.read((database) => database.counter), 20);
  assert.equal(JSON.parse(await readFile(file, "utf8")).counter, 20);
});
