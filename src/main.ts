import { readFile } from "node:fs/promises";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { createAwsPricer } from "./pricing.js";
import { run, upsertComment } from "./run.js";

const pullRequest = github.context.payload.pull_request as
  | { number: number; body?: string | null }
  | undefined;

await run({
  input: (name) => core.getInput(name),
  env: (name) => process.env[name],
  readFile: (path) => readFile(path, "utf8"),
  createPricer: (rateType) => createAwsPricer(rateType),
  pullRequest,
  postComment: async (body, marker) => {
    if (pullRequest === undefined) return;
    const octokit = github.getOctokit(core.getInput("github-token", { required: true }));
    const { owner, repo } = github.context.repo;
    await upsertComment(
      {
        listComments: (issue) =>
          octokit.paginate(octokit.rest.issues.listComments, { ...issue, per_page: 100 }),
        createComment: (params) => octokit.rest.issues.createComment(params),
        updateComment: (params) => octokit.rest.issues.updateComment(params),
      },
      { owner, repo, issue_number: pullRequest.number },
      marker,
      body,
    );
  },
  setOutput: (name, value) => core.setOutput(name, value),
  setFailed: (message) => core.setFailed(message),
  writeSummary: async (body) => {
    await core.summary.addRaw(body).write();
  },
  info: (message) => core.info(message),
});
