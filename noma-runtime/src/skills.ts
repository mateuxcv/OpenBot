/**
 * Learning Skills system for noma-runtime.
 *
 * Replaces the SkillRegistry, formatSkillCatalog, loadSkill and readSkillFile
 * exports from @copilotkit/runtime/internal/learned-skills, without any
 * dependency on that package.
 *
 * The SkillRegistry calls the noma-intelligence API endpoint
 * `/api/v1/learning/containers/:id/skills` and caches the result for
 * `freshnessWindowMs` milliseconds before refreshing.
 *
 * The snapshot format (`VerifiedSnapshot`) is intentionally compatible with the
 * CopilotKit type of the same name: the runtime.ts file in server/src/learning
 * deserialises merges and accesses it through the same fields.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SnapshotFile = {
  path: string;
  size: number;
  sha256: string;
  /** Text content of the file, present for text files. */
  text?: string;
};

export type SnapshotSkill = {
  name: string;
  description: string;
  files: SnapshotFile[];
};

export type VerifiedSnapshot = {
  revision: string;
  etag: string;
  skills: readonly SnapshotSkill[];
};

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

/**
 * API surface that SkillRegistry uses to fetch a snapshot.  An object
 * implementing `NomaSkillsClient` from noma-intelligence satisfies this.
 */
type SkillsClient = {
  getLearnedSkillsSnapshot(params: {
    containerId: string;
    revision?: string;
    signal?: AbortSignal;
  }): Promise<{
    revision: string;
    etag: string;
    skills: readonly { name: string; description: string; files: SnapshotFile[] }[];
  }>;
};

type SkillRegistryOptions = {
  /**
   * API base URL for the noma-intelligence server, used when no `client` is
   * supplied.  At least one of `apiUrl+apiKey` or `client` must be given.
   */
  apiUrl?: string;
  apiKey?: string;
  /** Pre-built client; takes precedence over apiUrl/apiKey. */
  client?: SkillsClient;
  /** The Learning container whose snapshot this registry tracks. */
  containerId?: string;
  /** Pin to a specific revision; absent means "latest". */
  revision?: string;
  /** How long a cached snapshot stays fresh before the next read. Default 60 s. */
  freshnessWindowMs?: number;
};

/** Status of the most recent snapshot read, exposed for telemetry. */
export type SkillRegistryStatus = {
  initialized: boolean;
  stale: boolean;
  revision?: string;
  lastCheckedAt?: string;
  lastError?: string;
};

/**
 * Cache and refresher for one Learning container's published Skills.
 *
 * Compatible with the SkillRegistry from @copilotkit/runtime: the same
 * `acquireSnapshot()` → `VerifiedSnapshot` contract, plus a `status` property
 * for the learning runtime's diagnostics.
 */
export class SkillRegistry {
  readonly #client: SkillsClient;
  readonly #containerId: string;
  readonly #revision: string | undefined;
  readonly #freshnessWindowMs: number;

  #snapshot: VerifiedSnapshot | undefined;
  #lastCheckedAt: number | undefined;
  #pendingRead: Promise<VerifiedSnapshot> | undefined;

  status: SkillRegistryStatus = { initialized: false, stale: false };

  constructor(options: SkillRegistryOptions) {
    if (!options.containerId) {
      throw new Error("SkillRegistry: containerId is required");
    }
    this.#containerId = options.containerId;
    this.#revision = options.revision;
    this.#freshnessWindowMs = options.freshnessWindowMs ?? 60_000;

    if (options.client) {
      this.#client = options.client;
    } else if (options.apiUrl && options.apiKey) {
      this.#client = buildHttpClient(options.apiUrl, options.apiKey);
    } else {
      throw new Error(
        "SkillRegistry: provide either client or apiUrl+apiKey",
      );
    }
  }

  /** Trigger the first snapshot read eagerly. */
  async initialize(): Promise<void> {
    await this.acquireSnapshot();
  }

  /**
   * Return a fresh snapshot, using the in-memory cache when it has not expired.
   *
   * Multiple concurrent calls share one in-flight read so Intelligence is not
   * hammered on a busy deployment.
   */
  acquireSnapshot(): Promise<VerifiedSnapshot> {
    const now = Date.now();
    if (
      this.#snapshot &&
      this.#lastCheckedAt !== undefined &&
      now - this.#lastCheckedAt < this.#freshnessWindowMs
    ) {
      return Promise.resolve(this.#snapshot);
    }

    if (this.#pendingRead) return this.#pendingRead;

    this.#pendingRead = this.#read()
      .then((snapshot) => {
        this.#snapshot = snapshot;
        this.#lastCheckedAt = Date.now();
        this.status = {
          initialized: true,
          stale: false,
          revision: snapshot.revision,
          lastCheckedAt: new Date().toISOString(),
        };
        return snapshot;
      })
      .catch((error: unknown) => {
        this.status = {
          ...this.status,
          stale: true,
          lastError:
            error instanceof Error ? error.message : String(error),
        };
        // If we have a cached snapshot, return it rather than failing.
        if (this.#snapshot) return this.#snapshot;
        throw error;
      })
      .finally(() => {
        this.#pendingRead = undefined;
      });

    return this.#pendingRead;
  }

  async #read(): Promise<VerifiedSnapshot> {
    const result = await this.#client.getLearnedSkillsSnapshot({
      containerId: this.#containerId,
      ...(this.#revision ? { revision: this.#revision } : {}),
    });

    return Object.freeze({
      revision: result.revision,
      etag: result.etag,
      skills: Object.freeze(
        result.skills.map((skill) =>
          Object.freeze({
            name: skill.name,
            description: skill.description,
            files: Object.freeze(skill.files.map((f) => Object.freeze({ ...f }))),
          }),
        ),
      ),
    });
  }
}

// ---------------------------------------------------------------------------
// Minimal HTTP client for environments without a pre-built SkillsClient
// ---------------------------------------------------------------------------

function buildHttpClient(apiUrl: string, apiKey: string): SkillsClient {
  const base = apiUrl.replace(/\/+$/, "");
  return {
    async getLearnedSkillsSnapshot({ containerId, signal }) {
      const res = await fetch(
        `${base}/api/v1/learning/containers/${encodeURIComponent(containerId)}/skills`,
        {
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
          },
          ...(signal ? { signal } : {}),
        },
      );
      if (!res.ok) {
        const err = new Error(`Skills API responded ${res.status}`) as Error & {
          code?: string;
        };
        try {
          const body = (await res.json()) as { code?: string };
          err.code = body.code;
        } catch {
          // ignore parse failure
        }
        throw err;
      }
      return res.json() as ReturnType<SkillsClient["getLearnedSkillsSnapshot"]>;
    },
  };
}

// ---------------------------------------------------------------------------
// formatSkillCatalog
// ---------------------------------------------------------------------------

/**
 * Returns an XML snippet listing all Skills in the snapshot, suitable for
 * inserting into a system prompt.
 *
 * Compatible with the CopilotKit version: the runtime's catalog prompt section
 * wraps this output in `<learned_skills>` tags.
 */
export function formatSkillCatalog(snapshot: VerifiedSnapshot): string {
  const lines: string[] = ["<skills>"];
  for (const skill of snapshot.skills) {
    lines.push(
      `  <skill name="${escapeXml(skill.name)}">${escapeXml(skill.description)}</skill>`,
    );
  }
  lines.push("</skills>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// loadSkill
// ---------------------------------------------------------------------------

/**
 * Returns a JSON string with the Skill's SKILL.md content and the list of its
 * supporting files.  Used by the `copilotkit_load_skill` tool handler.
 */
export function loadSkill(snapshot: VerifiedSnapshot, name: string): string {
  const skill = findSkill(snapshot, name);
  const skillMd = skill.files.find((f) => f.path === "SKILL.md");
  const otherFiles = skill.files
    .filter((f) => f.path !== "SKILL.md")
    .map((f) => ({ path: f.path, size: f.size }));
  return JSON.stringify({
    name: skill.name,
    description: skill.description,
    skillMd: skillMd?.text ?? null,
    files: otherFiles,
  });
}

// ---------------------------------------------------------------------------
// readSkillFile
// ---------------------------------------------------------------------------

/**
 * Returns the text content of one supporting file in a Skill.  Used by the
 * `copilotkit_read_skill_file` tool handler.
 */
export function readSkillFile(
  snapshot: VerifiedSnapshot,
  name: string,
  path: string,
): string {
  const skill = findSkill(snapshot, name);
  const file = skill.files.find((f) => f.path === path);
  if (!file) {
    throw new Error(
      `Skill "${name}" has no file at path "${path}".`,
    );
  }
  if (file.text === undefined) {
    throw new Error(`File "${path}" in skill "${name}" is not a text file.`);
  }
  return file.text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSkill(snapshot: VerifiedSnapshot, name: string): SnapshotSkill {
  const skill = snapshot.skills.find((s) => s.name === name);
  if (!skill) {
    throw new Error(
      `Skill "${name}" is not in this snapshot. Available: ${snapshot.skills.map((s) => s.name).join(", ")}`,
    );
  }
  return skill;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
