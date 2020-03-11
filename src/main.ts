import * as core from '@actions/core';
import * as github from '@actions/github';
import * as yaml from 'js-yaml';
import {Minimatch} from 'minimatch';

async function run(): Promise<void> {
  try {
    const token = core.getInput('repo-token', {required: true});
    const configPath = core.getInput('configuration-path', {required: true});
    const notFoundLabel = core.getInput('not-found-label');

    const operationsPerRun = parseInt(
      core.getInput('operations-per-run', {required: true})
    );
    if (operationsPerRun <= 0) {
      throw new Error(`operations-per-run must be greater than zero, got ${operationsPerRun}`);
    }
    let operationsLeft = operationsPerRun;

    const client = new github.GitHub(token);

    const labelGlobs = await getLabelGlobs(
      client,
      configPath
    );

    // If we were triggered for a specific PR, then process it.
    const thisPr = getThisPr();
    if (thisPr) {
      const { prNumber, existingLabels } = thisPr;
      await processPR(client, prNumber, existingLabels, labelGlobs, notFoundLabel);
      return;
    }

    // Otherwise, assume we are executing as a background cron job, finding
    // unlabeled PRs and labeling them. This is effectively a workaround for
    // https://github.com/actions/labeler/issues/12
    const opts = await client.pulls.list.endpoint.merge({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      state: 'open',
      sort: 'updated'
    });

    for await (const response of client.paginate.iterator(opts)) {
      for (const pr of response) {
        core.debug(`performing labeler at pr ${pr.number}`);
        if (operationsLeft <= 0) {
          core.warning(
            `performed ${operationsPerRun} operations, exiting to avoid rate limit`
          );
          return;
        }

        const existingLabels: Set<string> = new Set(...pr.labels.map(l => l.name));
        if (await processPR(
          client,
          pr.number,
          existingLabels,
          labelGlobs,
          notFoundLabel
        )) {
          operationsLeft -= 1;
        }
      }
    }
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

// Returns true if we did an API call and added labels, false if we didn't. This
// is useful for avoiding API rate limiting.
async function processPR(
  client: github.GitHub,
  prNumber: number,
  existingLabels: Set<string>,
  labelGlobs: Map<string, string[]>,
  notFoundLabel: string
): Promise<boolean> {
  try {
    core.debug(`fetching changed files for pr #${prNumber}`);
    const changedFiles: string[] = await getChangedFiles(client, prNumber);

    const labelsToAdd: string[] = [];
    for (const [label, globs] of labelGlobs.entries()) {
      core.debug(`processing ${label}`);
      if (existingLabels.has(label)) {
        core.debug(`pr #{prNumber} is already labeled "${label}"`);
        continue;
      }
      if (checkGlobs(changedFiles, globs)) {
        labelsToAdd.push(label);
      }
    }

    if (notFoundLabel && labelsToAdd.length === 0) {
      labelsToAdd.push(notFoundLabel);
    }

    if (labelsToAdd.length > 0) {
      await addLabels(client, prNumber, labelsToAdd);
      return true;
    }
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
  return false;
}

function getThisPr(): { prNumber: number, existingLabels: Set<string> } | undefined {
  const pullRequest = github.context.payload.pull_request;
  if (!pullRequest) {
    return undefined;
  }

  return {
    prNumber: pullRequest.number,
    existingLabels: new Set(
      ...pullRequest.labels(l => l.name)
    ),
  };
}

async function getChangedFiles(
  client: github.GitHub,
  prNumber: number
): Promise<string[]> {
  const listFilesResponse = await client.pulls.listFiles({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  });

  const changedFiles = listFilesResponse.data.map(f => f.filename);

  core.debug('found changed files:');
  for (const file of changedFiles) {
    core.debug('  ' + file);
  }

  return changedFiles;
}

async function getLabelGlobs(
  client: github.GitHub,
  configurationPath: string
): Promise<Map<string, string[]>> {
  const configurationContent: string = await fetchContent(
    client,
    configurationPath
  );

  // loads (hopefully) a `{[label:string]: string | string[]}`, but is `any`:
  const configObject: any = yaml.safeLoad(configurationContent);

  // transform `any` => `Map<string,string[]>` or throw if yaml is malformed:
  return getLabelGlobMapFromObject(configObject);
}

async function fetchContent(
  client: github.GitHub,
  repoPath: string
): Promise<string> {
  const response: any = await client.repos.getContents({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: repoPath,
    ref: github.context.sha
  });

  return Buffer.from(response.data.content, response.data.encoding).toString();
}

function getLabelGlobMapFromObject(configObject: any): Map<string, string[]> {
  const labelGlobs: Map<string, string[]> = new Map();
  for (const label in configObject) {
    if (typeof configObject[label] === 'string') {
      labelGlobs.set(label, [configObject[label]]);
    } else if (configObject[label] instanceof Array) {
      labelGlobs.set(label, configObject[label]);
    } else {
      throw Error(
        `found unexpected type for label ${label} (should be string or array of globs)`
      );
    }
  }

  return labelGlobs;
}

function checkGlobs(changedFiles: string[], globs: string[]): boolean {
  for (const glob of globs) {
    core.debug(` checking pattern ${glob}`);
    const matcher = new Minimatch(glob);
    for (const changedFile of changedFiles) {
      core.debug(` - ${changedFile}`);
      if (matcher.match(changedFile)) {
        core.debug(` ${changedFile} matches`);
        return true;
      }
    }
  }
  return false;
}

async function addLabels(
  client: github.GitHub,
  prNumber: number,
  labels: string[]
) {
  core.debug(`adding labels to pr #{prNumber}: ${labels.map(l => '"' + l + '"').join(", ")}`);
  await client.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
    labels: labels
  });
}

run();
