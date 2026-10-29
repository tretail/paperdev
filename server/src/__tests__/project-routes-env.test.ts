import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/activity-log.js", async () => ({
    ...await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js"),
    persistActivity: async (db: unknown, input: unknown) => { await mockLogActivity(db, input); return { activity: { id: "activity" }, publication: null }; },
    publishActivity: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp(overrides: { actor?: Record<string, unknown>; db?: Record<string, unknown> } = {}) {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = overrides.actor ?? {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({
    transaction: async (effect: (tx: unknown) => unknown) => effect({}),
    ...overrides.db,
  } as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("project env routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockEnvironmentService.getById.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
  });

  it('requires workspace-write authority to attach a repository despite project read access', async () => {
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockAccessService.decide.mockImplementation(async (input) => ({ allowed: input.action !== 'project:write_workspace',
      action: input.action, reason: 'deny_no_grant', explanation: 'Workspace write permission required.' }));
    const app = await createApp();
    await request(app).post('/api/projects/project-1/workspaces').send({ name: 'Repository', repoUrl: 'https://github.com/acme/skills' }).expect(403);
    await request(app).put('/api/projects/project-1/repositories').send({ repositoryIds: ['42'] }).expect(403);
    expect(mockProjectService.createWorkspace).not.toHaveBeenCalled();
  });

  it("normalizes env bindings on create and logs only env keys", async () => {
    const normalizedEnv = {
      API_KEY: {
        type: "secret_ref",
        secretId: "11111111-1111-4111-8111-111111111111",
        version: "latest",
      },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.create.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        env: normalizedEnv,
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      normalizedEnv,
      expect.objectContaining({ fieldPath: "env" }),
    );
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ env: normalizedEnv }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          envKeys: ["API_KEY"],
        }),
      }),
    );
  });

  it("normalizes env bindings on update and avoids logging raw values", async () => {
    const normalizedEnv = {
      PLAIN_KEY: { type: "plain", value: "top-secret" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        env: normalizedEnv,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: {
          changedKeys: ["env"],
          envKeys: ["PLAIN_KEY"],
        },
      }),
    );
  });

  describe("plan approval policy", () => {
    const implementerId = "22222222-2222-4222-8222-222222222222";
    const selectReturning = (rows: unknown[]) => ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    });

    it("rejects agent changes to the plan approval policy", async () => {
      const app = await createApp({
        actor: { type: "agent", agentId: "agent-1", companyId: "company-1", companyIds: ["company-1"], source: "agent_key" },
      });
      const res = await request(app)
        .post("/api/companies/company-1/projects")
        .send({ name: "Sneaky", planApprovalPolicy: { enabled: false } });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockProjectService.create).not.toHaveBeenCalled();
    });

    it("lets the board enable the gate and logs the policy", async () => {
      const policy = { enabled: true, implementerAgentId: implementerId };
      mockProjectService.getById.mockResolvedValue(buildProject());
      mockProjectService.update.mockResolvedValue(buildProject({ planApprovalPolicy: policy }));
      const app = await createApp({ db: selectReturning([{ id: implementerId }]) });
      const res = await request(app).patch("/api/projects/project-1").send({ planApprovalPolicy: policy });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockProjectService.update).toHaveBeenCalledWith("project-1", expect.objectContaining({ planApprovalPolicy: policy }));
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ details: expect.objectContaining({ planApprovalPolicy: policy }) }),
      );
    });

    it("rejects an implementer from another company", async () => {
      mockProjectService.getById.mockResolvedValue(buildProject());
      const app = await createApp({ db: selectReturning([]) });
      await request(app)
        .patch("/api/projects/project-1")
        .send({ planApprovalPolicy: { enabled: true, implementerAgentId: implementerId } })
        .expect(422);
      expect(mockProjectService.update).not.toHaveBeenCalled();
    });
  });
});
