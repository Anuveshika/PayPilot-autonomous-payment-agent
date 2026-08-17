import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const emptyDatabase = () => ({
  schemaVersion: 1,
  sessions: {},
  usageEvents: {},
  usageIdempotency: {},
  settlements: {},
  settlementIdempotency: {},
  usedAuthorizationNonces: {},
});

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyDatabase();
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.data = { ...emptyDatabase(), ...JSON.parse(await readFile(this.filePath, "utf8")) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.#persist(this.data);
    }
    return this;
  }

  read(selector = (database) => database) {
    return structuredClone(selector(this.data));
  }

  transaction(mutator) {
    const run = async () => {
      const draft = structuredClone(this.data);
      const result = await mutator(draft);
      await this.#persist(draft);
      this.data = draft;
      return structuredClone(result);
    };
    const operation = this.queue.then(run, run);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #persist(database) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
