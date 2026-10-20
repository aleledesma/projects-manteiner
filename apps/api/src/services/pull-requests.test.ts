import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppError } from "../errors.ts";
import type { GithubPublishRepository } from "./github-app.ts";
import { assertPushTarget, pushBranchFor } from "./push-target.ts";
import {
  filesInDiff,
  type PublishGithubClient,
  type PublishPullRequestInput,
  PullRequestService,
} from "./pull-requests.ts";
import type { PublishBranchInput, PublishBranchResult, PublishRuntime } from "./repository-workspace.ts";

const RUN_ID = "0123abcd-1111-4111-8111-111111111111";

const input: PublishPullRequestInput = {
  runId: RUN_ID,
  auditType: "maintenance",
  installationId: 777,
  githubRepositoryId: 999,
  volumeName: "manteiner-ws-test",
  baseSha: "a".repeat(40),
  title: "chore(deps): actualizar dependencias",
  body: "Actualiza dos paquetes.",
  touchedFiles: ["package.json", "package-lock.json", "src/index.ts"],
};

class FakeGithub implements PublishGithubClient {
  readonly calls: string[] = [];
  repository: Partial<GithubPublishRepository> = {};
  prError?: Error;
  lastBody = "";

  async createPublishToken(installationId: number, repositoryId: number) {
    this.calls.push(`token:${installationId}:${repositoryId}`);
    return "publish-token";
  }

  async getRepositoryForPublish(_token: string, repositoryId: number) {
    this.calls.push("repo");
    return {
      id: repositoryId,
      owner: { login: "octocat" },
      name: "hello-world",
      default_branch: "main",
      archived: false,
      ...this.repository,
    };
  }

  async createPullRequest(_token: string, pr: { head: string; base: string; body: string }) {
    this.calls.push(`pr:${pr.head}->${pr.base}`);
    this.lastBody = pr.body;
    if (this.prError) throw this.prError;
    return { number: 42, html_url: "https://github.com/octocat/hello-world/pull/42" };
  }

  async revokeInstallationToken(token: string) {
    this.calls.push(`revoke:${token}`);
  }
}

class FakeRuntime implements PublishRuntime {
  received?: PublishBranchInput;
  constructor(private readonly result: PublishBranchResult) {}

  async publishBranch(value: PublishBranchInput) {
    this.received = value;
    return this.result;
  }
}

const pushed: PublishBranchResult = {
  status: "pushed",
  commitSha: "c".repeat(40),
  files: ["package.json", "package-lock.json"],
};

describe("assertPushTarget", () => {
  it("acepta solo ramas manteiner/ generadas por la app", () => {
    const branch = pushBranchFor("maintenance", RUN_ID);
    assert.equal(branch, "manteiner/maintenance/0123abcd");
    assert.doesNotThrow(() => assertPushTarget(branch, "main"));
  });

  it("rechaza la rama por defecto y cualquier otra", () => {
    for (const [branch, base] of [
      ["main", "main"],
      ["master", "main"],
      ["manteiner/maintenance/0123abcd", "manteiner/maintenance/0123abcd"],
      ["manteiner/maintenance/../../main", "main"],
      ["refs/heads/main", "main"],
    ] as const) {
      assert.throws(
        () => assertPushTarget(branch, base),
        (error: unknown) => error instanceof AppError && error.code === "INVALID_PUSH_TARGET",
      );
    }
  });
});

describe("PullRequestService", () => {
  it("pushea la rama computada, abre el PR contra la rama por defecto y revoca el token", async () => {
    const github = new FakeGithub();
    const runtime = new FakeRuntime(pushed);
    const result = await new PullRequestService(github, runtime).publish(input);

    assert.deepEqual(result, {
      status: "created",
      number: 42,
      url: "https://github.com/octocat/hello-world/pull/42",
      branch: "manteiner/maintenance/0123abcd",
      commitSha: "c".repeat(40),
      files: ["package.json", "package-lock.json"],
      discarded: ["src/index.ts"],
    });
    assert.equal(runtime.received?.headBranch, "manteiner/maintenance/0123abcd");
    assert.equal(runtime.received?.defaultBranch, "main");
    assert.equal(runtime.received?.baseSha, "a".repeat(40));
    assert.deepEqual(github.calls, [
      "token:777:999",
      "repo",
      "pr:manteiner/maintenance/0123abcd->main",
      "revoke:publish-token",
    ]);
    assert.match(github.lastBody, /Actualiza dos paquetes/);
    assert.match(github.lastBody, /src\/index\.ts/);
    assert.match(github.lastBody, /Manteiner/);
  });

  it("saltea el PR si el repositorio esta archivado, sin pushear", async () => {
    const github = new FakeGithub();
    github.repository = { archived: true };
    const runtime = new FakeRuntime(pushed);
    const result = await new PullRequestService(github, runtime).publish(input);

    assert.equal(result.status, "skipped");
    assert.equal(result.status === "skipped" && result.code, "REPO_ARCHIVED");
    assert.equal(runtime.received, undefined);
    assert.equal(github.calls.at(-1), "revoke:publish-token");
  });

  it("saltea el PR si no quedo ningun cambio permitido", async () => {
    const github = new FakeGithub();
    const result = await new PullRequestService(github, new FakeRuntime({ status: "no-changes" }))
      .publish(input);

    assert.equal(result.status === "skipped" && result.code, "NO_ALLOWED_CHANGES");
    assert.ok(!github.calls.some((call) => call.startsWith("pr:")));
  });

  it("si falla el POST /pulls informa la rama ya publicada", async () => {
    const github = new FakeGithub();
    github.prError = new AppError("PR_CREATE_FAILED", "rechazado", 502);
    const result = await new PullRequestService(github, new FakeRuntime(pushed)).publish(input);

    assert.deepEqual(result, {
      status: "failed",
      code: "PR_CREATE_FAILED",
      message: "rechazado",
      branch: "manteiner/maintenance/0123abcd",
    });
    assert.equal(github.calls.at(-1), "revoke:publish-token");
  });

  it("no degrada INVALID_PUSH_TARGET: si la rama por defecto coincide, el error sube", async () => {
    const github = new FakeGithub();
    github.repository = { default_branch: "manteiner/maintenance/0123abcd" };
    const runtime = new FakeRuntime(pushed);
    await assert.rejects(
      () => new PullRequestService(github, runtime).publish(input),
      (error: unknown) => error instanceof AppError && error.code === "INVALID_PUSH_TARGET",
    );
    assert.equal(runtime.received, undefined);
    assert.equal(github.calls.at(-1), "revoke:publish-token");
  });
});

describe("filesInDiff", () => {
  it("lista los archivos de un diff unificado de git", () => {
    const diff = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "diff --git a/src/a b.ts b/src/a b.ts",
    ].join("\n");
    assert.deepEqual(filesInDiff(diff), ["package.json", "src/a b.ts"]);
  });
});
