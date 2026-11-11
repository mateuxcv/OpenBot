/**
 * API de administração de Learning containers — substitui
 * CopilotKitIntelligence["experimental"]["learning"].
 *
 * O OpenBot usa este contrato para listar containers, rodar análises,
 * revisar candidates e publicar Skills. Com Noma, essa API aponta para
 * o próprio backend local (noma-intelligence) em vez dos servidores
 * da CopilotKit.
 */

// ---------------------------------------------------------------------------
// Tipos compartilhados
// ---------------------------------------------------------------------------

export type LearningContainerInfo = {
  id: string;
  status: "active" | "inactive";
  createdAt: string;
};

export type LearningRunSummaryItem = {
  id: string;
  containerId: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
};

export type LearningCandidateItem = {
  id: string;
  containerId: string;
  name: string;
  description: string;
  status: "pending" | "approved" | "rejected";
};

export type LearningInsightEvidence = {
  id: string;
  content: string;
  source?: string;
};

// ---------------------------------------------------------------------------
// Interface de administração de Learning
// ---------------------------------------------------------------------------

export interface NomaLearningManagement {
  getLearningContainer(params: {
    containerId: string;
    signal?: AbortSignal;
  }): Promise<LearningContainerInfo>;

  listLearningRuns(params: {
    containerId: string;
    signal?: AbortSignal;
  }): Promise<{ runs: LearningRunSummaryItem[] }>;

  startLearningRun(params: {
    containerId: string;
    signal?: AbortSignal;
  }): Promise<{ runId: string }>;

  listLearningCandidates(params: {
    containerId: string;
    signal?: AbortSignal;
  }): Promise<{ candidates: LearningCandidateItem[] }>;

  getLearningCandidate(params: {
    containerId: string;
    candidateId: string;
    signal?: AbortSignal;
  }): Promise<LearningCandidateItem>;

  getLearningInsightEvidence(params: {
    containerId: string;
    insightId: string;
    signal?: AbortSignal;
  }): Promise<{ evidence: LearningInsightEvidence[] }>;

  reviewLearningCandidate(params: {
    containerId: string;
    candidateId: string;
    decision: "approve" | "reject";
    signal?: AbortSignal;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Interface de snapshot de Skills publicadas
// ---------------------------------------------------------------------------

export type LearnedSkillFile = {
  path: string;
  size: number;
  sha256: string;
  text?: string;
};

export type LearnedSkillEntry = {
  name: string;
  description: string;
  files: LearnedSkillFile[];
};

export type LearnedSkillsSnapshot = {
  revision: string;
  etag: string;
  skills: LearnedSkillEntry[];
};

export interface NomaSkillsClient {
  getLearnedSkillsSnapshot(params: {
    containerId: string;
    revision?: string;
    signal?: AbortSignal;
  }): Promise<LearnedSkillsSnapshot>;
}

// ---------------------------------------------------------------------------
// Implementação HTTP — aponta para o servidor Noma local
// ---------------------------------------------------------------------------

import { PlatformRequestError } from "./errors";

export function createNomaLearningManagement(options: {
  apiUrl: string;
  apiKey: string;
}): NomaLearningManagement & NomaSkillsClient {
  const base = options.apiUrl.replace(/\/+$/, "");

  async function request<T>(
    path: string,
    opts: RequestInit = {},
  ): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
        ...(opts.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      const error = new PlatformRequestError(
        (body.message as string | undefined) ?? `HTTP ${res.status}`,
        res.status,
        res.status >= 500 || res.status === 408 || res.status === 429,
      );
      (error as PlatformRequestError & { code?: string }).code =
        (body.code as string | undefined);
      throw error;
    }
    return res.json() as Promise<T>;
  }

  return {
    async getLearningContainer({ containerId, signal }) {
      return request<LearningContainerInfo>(
        `/api/v1/learning/containers/${encodeURIComponent(containerId)}`,
        { signal },
      );
    },
    async listLearningRuns({ containerId, signal }) {
      return request<{ runs: LearningRunSummaryItem[] }>(
        `/api/v1/learning/containers/${encodeURIComponent(containerId)}/runs`,
        { signal },
      );
    },
    async startLearningRun({ containerId, signal }) {
      return request<{ runId: string }>(
        `/api/v1/learning/containers/${encodeURIComponent(containerId)}/runs`,
        { method: "POST", signal },
      );
    },
    async listLearningCandidates({ containerId, signal }) {
      return request<{ candidates: LearningCandidateItem[] }>(
        `/api/v1/learning/containers/${encodeURIComponent(containerId)}/candidates`,
        { signal },
      );
    },
    async getLearningCandidate({ containerId, candidateId, signal }) {
      return request<LearningCandidateItem>(
        `/api/v1/learning/containers/${encodeURIComponent(containerId)}/candidates/${encodeURIComponent(candidateId)}`,
        { signal },
      );
    },
    async getLearningInsightEvidence({ containerId, insightId, signal }) {
      return request<{ evidence: LearningInsightEvidence[] }>(
        `/api/v1/learning/containers/${encodeURIComponent(containerId)}/insights/${encodeURIComponent(insightId)}/evidence`,
        { signal },
      );
    },
    async reviewLearningCandidate({ containerId, candidateId, decision, signal }) {
      await request<void>(
        `/api/v1/learning/containers/${encodeURIComponent(containerId)}/candidates/${encodeURIComponent(candidateId)}/${decision}`,
        { method: "POST", signal },
      );
    },
    async getLearnedSkillsSnapshot({ containerId, signal }) {
      return request<LearnedSkillsSnapshot>(
        `/api/v1/learning/containers/${encodeURIComponent(containerId)}/skills`,
        { signal },
      );
    },
  };
}
