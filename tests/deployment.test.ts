import { describe, expect, it } from "vitest";
import { deploymentIssues } from "../src/config/deployment";

const env = {
  DATABASE_URL: "postgresql://user:password@db.example.com/app?sslmode=require",
  TRIGGER_SECRET_KEY: "tr_prod_test_only", TRIGGER_PROJECT_REF: "proj_test",
  OPENROUTER_API_KEY: "test_only", OPENROUTER_MODEL: "openrouter/free",
  FRONTEND_ORIGIN: "https://frontend.example.com", PUBLIC_API_BASE_URL: "https://api.example.com",
  UPLOAD_PUBLIC_API_ORIGIN: "https://api.example.com", CLERK_SECRET_KEY: "sk_test_example", CLERK_PUBLISHABLE_KEY: "pk_test_example",
  MAGICA_API_BASE_URL: "https://inference.magica.com", MAGICA_API_KEY: "test_only",
  WEBHOOK_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), TRANSLOADIT_PLAN: "community",
  TRANSLOADIT_AUTH_KEY: "a".repeat(32), TRANSLOADIT_AUTH_SECRET: "test_only",
  UPLOAD_S3_ENDPOINT: "https://s3.example.com", UPLOAD_S3_REGION: "test-region", UPLOAD_S3_BUCKET: "test-bucket",
  UPLOAD_S3_ACCESS_KEY_ID: "test_only", UPLOAD_S3_SECRET_ACCESS_KEY: "test_only",
};
describe("production deployment configuration", () => {
  it("accepts the free route and encrypted remote database", () => expect(deploymentIssues(env)).toEqual([]));
  it.each([
    ["DATABASE_URL", "postgresql://user:private@localhost/app?sslmode=require"],
    ["DATABASE_URL", "postgresql://user:private@db.example.com/app"],
    ["TRIGGER_SECRET_KEY", "tr_dev_private"],
    ["OPENROUTER_MODEL", "paid/model"],
    ["UPLOAD_PUBLIC_API_ORIGIN", "https://wrong.example.com"],
    ["WEBHOOK_MASTER_KEY", "private"],
    ["DATABASE_URL", "malformed-private-value"],
    ["PUBLIC_API_BASE_URL", "malformed-private-value"],
  ])("rejects invalid %s without exposing its value", (field, value) => {
    const issues = deploymentIssues({ ...env, [field]: value });
    expect(issues).toContain(field);
    expect(issues.join(",")).not.toContain(value);
  });
  it("rejects a paid upload plan", () => expect(deploymentIssues({ ...env, TRANSLOADIT_PLAN: "paid" })).toContain("UPLOAD_CONFIGURATION"));
  it("validates the optional direct migration connection", () => expect(deploymentIssues({ ...env, DIRECT_URL: "postgresql://localhost/app" })).toContain("DIRECT_URL"));
});
