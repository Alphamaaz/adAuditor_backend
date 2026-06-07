import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { RuleMetadataSchema, PLAN_TIER_RANK } from "./schemas/rule.schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RULE_DIRS = [
  "meta",
  "google",
  "tiktok",
  "business-profile",
  "benchmark",
  "opportunity",
  "compound",
];

const findRuleFiles = () => {
  const files = [];
  for (const dir of RULE_DIRS) {
    const absDir = path.join(__dirname, dir);
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".rule.js")) continue;
      files.push(path.join(absDir, entry.name));
    }
  }
  return files;
};

const loadRules = async () => {
  const files = findRuleFiles();
  const rules = [];
  for (const file of files) {
    const url = pathToFileURL(file).href;
    const mod = await import(url);
    const ruleDef = mod.default;
    if (!ruleDef) {
      throw new Error(`Rule file ${file} has no default export.`);
    }
    if (typeof ruleDef.eval !== "function") {
      throw new Error(`Rule at ${file} is missing eval() function.`);
    }
    const { eval: evalFn, ...metaInput } = ruleDef;
    const parsed = RuleMetadataSchema.safeParse(metaInput);
    if (!parsed.success) {
      throw new Error(
        `Rule metadata invalid at ${file}: ${parsed.error.message}`
      );
    }
    rules.push({ ...parsed.data, eval: evalFn, _filePath: file });
  }
  rules.sort((a, b) => a.id.localeCompare(b.id));
  return rules;
};

class Registry {
  constructor() {
    this._rules = null;
    this._byId = null;
  }

  async ensureLoaded() {
    if (this._rules) return;
    this._rules = await loadRules();
    this._byId = new Map(this._rules.map((rule) => [rule.id, rule]));
  }

  getAll() {
    this._assertLoaded();
    return this._rules.filter((rule) => !rule.deprecated);
  }

  getById(id) {
    this._assertLoaded();
    return this._byId.get(id);
  }

  forPlatform(platform) {
    return this.getAll().filter((rule) => rule.platforms.includes(platform));
  }

  forPlanTier(planTier) {
    const rank = PLAN_TIER_RANK[planTier] ?? 0;
    return this.getAll().filter(
      (rule) => PLAN_TIER_RANK[rule.minPlanTier] <= rank
    );
  }

  forContextVersion(version) {
    return this.getAll().filter((rule) => rule.contextVersion === version);
  }

  _assertLoaded() {
    if (!this._rules) {
      throw new Error(
        "Registry not loaded. Call `await registry.ensureLoaded()` first."
      );
    }
  }
}

export const registry = new Registry();
