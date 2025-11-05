import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Gitify');
  const disposable = vscode.commands.registerCommand('gitify.showBranches', async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showErrorMessage('Open a folder containing a Git repository to view branches.');
      return;
    }

// moved to top-level below

async function makeHead(cwd: string, branch: string, commit: string): Promise<void> {
  await execPromise(`git merge-base --is-ancestor ${commit} ${branch}`, cwd).catch(() => {
    throw new Error(`Commit ${commit} is not reachable from ${branch}.`);
  });
  await ensureCleanState(cwd);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRef = `refs/backup/git-dnd/${branch}-${ts}`;
  await execPromise(`git update-ref ${backupRef} ${branch}`, cwd).catch(() => {});

  const currentBranch = (await execPromise(`git rev-parse --abbrev-ref HEAD`, cwd)).trim();
  const switchBack = currentBranch !== branch;
  if (switchBack) {
    await execPromise(`git checkout ${branch}`, cwd);
  }
  try {
    const parentsLine = await execPromise(`git rev-list --parents -n 1 ${commit}`, cwd);
    const parts = parentsLine.trim().split(/\s+/);
    if (parts.length < 2) {
      // Root history reorder is unsafe across merge commits
      if (await hasMergesInHistory(cwd)) {
        throw new Error('Reordering from root across merge commits is not supported.');
      }
      const hashes = (await execPromise(`git rev-list --reverse HEAD`, cwd)).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (hashes.length <= 1) return; // nothing to reorder
      const reordered = hashes.filter(h => h !== commit).concat([commit]);
      const todo = reordered.map(h => `pick ${h}`).join('\n') + '\n';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-dnd-'));
      const todoPath = path.join(tmpDir, 'todo.txt');
      fs.writeFileSync(todoPath, todo, 'utf8');
      const editorScript = path.join(tmpDir, 'editor.sh');
      const scriptBody = `#!/bin/sh\ncat "${todoPath}" > "$1"\n`;
      fs.writeFileSync(editorScript, scriptBody, { encoding: 'utf8', mode: 0o755 });
      try {
        await execPromise(`git rebase -i --root`, cwd, { GIT_SEQUENCE_EDITOR: editorScript });
      } catch (e) {
        await execPromise(`git rebase --abort`, cwd).catch(() => {});
        await execPromise(`git update-ref refs/heads/${branch} ${backupRef}`, cwd).catch(() => {});
        throw e;
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
      return;
    }
    if (parts.length > 2) throw new Error('Reordering merge commits is not supported.');
    const parent = parts[1];

    const range = (await execPromise(`git rev-list --reverse ${parent}..HEAD`, cwd)).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const sequence = range.filter(h => h !== commit).concat([commit]);

    await execPromise(`git reset --hard ${parent}`, cwd);
    for (const h of sequence) {
      try {
        await execPromise(`git cherry-pick ${h}`, cwd);
      } catch (e: any) {
        const msg = String(e?.message || e || '');
        if (/previous cherry-pick is now empty/i.test(msg) || /The previous cherry-pick is now empty/i.test(msg)) {
          await execPromise(`git cherry-pick --skip`, cwd).catch(() => {});
          continue;
        }
        await execPromise(`git cherry-pick --abort`, cwd).catch(() => {});
        await execPromise(`git update-ref refs/heads/${branch} ${backupRef}`, cwd).catch(() => {});
        throw e;
      }
    }
  } finally {
    if (switchBack) {
      await execPromise(`git checkout ${currentBranch}`, cwd);
    }
  }
}

    const panel = vscode.window.createWebviewPanel(
      'gitifyBranches',
      'Gitify – Branches',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'dist')
        ]
      }
    );

    panel.webview.html = getWebviewHtml(panel.webview, context);

    const sendBranches = async () => {
      try {
        log.appendLine('[branches] refreshing');
        const branches = await getLocalBranches(workspace.uri.fsPath);
        panel.webview.postMessage({ type: 'branches', payload: branches });
      } catch (err: any) {
        log.appendLine(`[branches] error: ${err?.message || err}`);
        panel.webview.postMessage({ type: 'error', payload: err?.message ?? String(err) });
      }
    };

    await sendBranches();

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'refresh') {
        log.appendLine('[webview] refresh requested');
        await sendBranches();
      } else if (msg.type === 'ready') {
        log.appendLine('[webview] ready');
        await sendBranches();
      } else if (msg.type === 'getCommits' && typeof msg.branch === 'string') {
        try {
          log.appendLine(`[commits] request for branch=${msg.branch}`);
          const commits = await getCommits(workspace.uri.fsPath, msg.branch, 50);
          panel.webview.postMessage({ type: 'commits', payload: { branch: msg.branch, commits, requestId: msg.requestId } });
        } catch (err: any) {
          log.appendLine(`[commits] error: ${err?.message || err}`);
          panel.webview.postMessage({ type: 'error', payload: err?.message ?? String(err) });
        }
      } else if (msg.type === 'deleteCommit' && typeof msg.branch === 'string' && typeof msg.hash === 'string') {
        try {
          log.appendLine(`[delete] branch=${msg.branch} hash=${msg.hash}`);
          await deleteCommit(workspace.uri.fsPath, msg.branch, msg.hash);
          log.appendLine('[delete] success');
          const commits = await getCommits(workspace.uri.fsPath, msg.branch, 50);
          panel.webview.postMessage({ type: 'deleteResult', payload: { ok: true, branch: msg.branch, message: `Deleted commit ${msg.hash.slice(0,7)} from ${msg.branch}` } });
          panel.webview.postMessage({ type: 'commits', payload: { branch: msg.branch, commits } });
          await sendBranches();
        } catch (err: any) {
          log.appendLine(`[delete] error: ${err?.message || err}`);
          panel.webview.postMessage({ type: 'deleteResult', payload: { ok: false, branch: msg.branch, error: err?.message ?? String(err) } });
        }
      } else if (msg.type === 'makeHead' && typeof msg.branch === 'string' && typeof msg.hash === 'string') {
        try {
          log.appendLine(`[makeHead] branch=${msg.branch} hash=${msg.hash}`);
          await makeHead(workspace.uri.fsPath, msg.branch, msg.hash);
          log.appendLine('[makeHead] success');
          const [commits] = await Promise.all([
            getCommits(workspace.uri.fsPath, msg.branch, 50)
          ]);
          panel.webview.postMessage({ type: 'makeHeadResult', payload: { ok: true, branch: msg.branch, message: `Moved ${msg.branch} to ${msg.hash.slice(0,7)}` } });
          panel.webview.postMessage({ type: 'commits', payload: { branch: msg.branch, commits } });
          await sendBranches();
        } catch (err: any) {
          log.appendLine(`[makeHead] error: ${err?.message || err}`);
          panel.webview.postMessage({ type: 'makeHeadResult', payload: { ok: false, branch: msg.branch, error: err?.message ?? String(err) } });
        }
      }
    });

    const gitWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspace, '.git/refs/**'));
    gitWatcher.onDidChange(sendBranches);
    gitWatcher.onDidCreate(sendBranches);
    gitWatcher.onDidDelete(sendBranches);
    context.subscriptions.push(gitWatcher);

    panel.onDidDispose(() => {
      gitWatcher.dispose();
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

async function getLocalBranches(cwd: string): Promise<{ name: string; current: boolean }[]> {
  const cmd = 'git branch --format="%(refname:short)||%(HEAD)"';
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      const list = stdout
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
          const [name, headMarker] = line.split('||');
          return { name, current: headMarker === '*' };
        });
      resolve(list);
    });
  });
}

async function deleteCommit(cwd: string, branch: string, commit: string): Promise<void> {
  await execPromise(`git merge-base --is-ancestor ${commit} ${branch}`, cwd).catch(() => {
    throw new Error(`Commit ${commit} is not reachable from ${branch}.`);
  });
  await ensureCleanState(cwd);

  const parentsLine = await execPromise(`git rev-list --parents -n 1 ${commit}`, cwd);
  const parts = parentsLine.trim().split(/\s+/);
  // Prepare backup for safety
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRef = `refs/backup/git-dnd/${branch}-${ts}`;
  await execPromise(`git update-ref ${backupRef} ${branch}`, cwd).catch(() => {});

  // If root commit, drop it via interactive rebase from root
  if (parts.length < 2) {
    if (await hasMergesInHistory(cwd)) {
      throw new Error('Deleting the root across merge commits is not supported.');
    }
    const currentBranch = (await execPromise(`git rev-parse --abbrev-ref HEAD`, cwd)).trim();
    const switchBack = currentBranch !== branch;
    if (switchBack) {
      await execPromise(`git checkout ${branch}`, cwd);
    }
    try {
      const hashes = (await execPromise(`git rev-list --reverse HEAD`, cwd)).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (hashes.length <= 1) {
        throw new Error('Cannot delete the only commit on the branch. Delete the branch instead.');
      }
      // Drop first commit by writing todo without the first pick
      const todo = hashes.slice(1).map(h => `pick ${h}`).join('\n') + '\n';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-dnd-'));
      const todoPath = path.join(tmpDir, 'todo.txt');
      fs.writeFileSync(todoPath, todo, 'utf8');
      const editorScript = path.join(tmpDir, 'editor.sh');
      const scriptBody = `#!/bin/sh\ncat "${todoPath}" > "$1"\n`;
      fs.writeFileSync(editorScript, scriptBody, { encoding: 'utf8', mode: 0o755 });
      try {
        await execPromise(`git rebase -i --root`, cwd, { GIT_SEQUENCE_EDITOR: editorScript });
      } catch (e) {
        await execPromise(`git rebase --abort`, cwd).catch(() => {});
        await execPromise(`git update-ref refs/heads/${branch} ${backupRef}`, cwd).catch(() => {});
        throw e;
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    } finally {
      // Switch back to original branch if necessary
      const headNow = (await execPromise(`git rev-parse --abbrev-ref HEAD`, cwd)).trim();
      if (headNow !== currentBranch) {
        await execPromise(`git checkout ${currentBranch}`, cwd).catch(() => {});
      }
    }
    return;
  }
  if (parts.length > 2) throw new Error('Deleting merge commits is not supported.');
  const parent = parts[1];

  const tip = (await execPromise(`git rev-parse ${branch}`, cwd)).trim();
  const currentBranch = (await execPromise(`git rev-parse --abbrev-ref HEAD`, cwd)).trim();
  const isCurrent = currentBranch === branch;
  if (tip === commit) {
    if (isCurrent) {
      await execPromise(`git reset --hard ${parent}`, cwd);
    } else {
      await execPromise(`git update-ref refs/heads/${branch} ${parent}`, cwd);
    }
    return;
  }

  const rebaseCmd = isCurrent
    ? `git rebase --onto ${parent} ${commit}`
    : `git rebase --onto ${parent} ${commit} ${branch}`;
  await execPromise(rebaseCmd, cwd).catch(async (e) => {
    await execPromise(`git rebase --abort`, cwd).catch(() => {});
    throw new Error(`Rebase failed while deleting commit. ${e?.message || e}`);
  });
}

function execPromise(cmd: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, env: env ? { ...process.env, ...env } : undefined }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(stdout);
    });
  });
}

// Top-level helpers used by makeHead/deleteCommit
async function ensureCleanState(cwd: string): Promise<void> {
  const dirtyWc = await execPromise(`git diff --quiet || echo DIRTY`, cwd).then(s => /DIRTY/.test(s)).catch(() => true);
  const dirtyIdx = await execPromise(`git diff --cached --quiet || echo DIRTY`, cwd).then(s => /DIRTY/.test(s)).catch(() => true);
  if (dirtyWc || dirtyIdx) {
    throw new Error('Working tree has uncommitted changes. Please commit or stash before proceeding.');
  }
  const checks = [
    '[ -d .git/rebase-merge ]',
    '[ -d .git/rebase-apply ]',
    '[ -f .git/MERGE_HEAD ]',
    '[ -f .git/CHERRY_PICK_HEAD ]',
    '[ -f .git/REVERT_HEAD ]'
  ];
  const inProgress = await execPromise(`sh -c "${checks.join(' || ')} && echo BUSY || true"`, cwd)
    .then(s => /BUSY/.test(s)).catch(() => true);
  if (inProgress) {
    throw new Error('Another Git operation is in progress (rebase/merge/cherry-pick). Please abort/finish it first.');
  }
}

async function hasMergesInHistory(cwd: string): Promise<boolean> {
  const out = await execPromise(`git rev-list --parents --reverse HEAD`, cwd).catch(() => '');
  return out.split(/\r?\n/).some(line => line && line.trim().split(/\s+/).length > 2);
}

async function getCommits(cwd: string, ref: string, limit: number): Promise<{ hash: string; fullHash: string; subject: string; author: string; date: string }[]> {
  const sanitize = (s: string) => s.replace(/"/g, '\\"');
  const pretty = '%H%x1f%s%x1f%an%x1f%ad%x1e';
  const n = Math.max(1, Math.min(500, limit));

  // Determine base branch: configuration or fallback to main/master
  let base: string | null = null;
  try {
    const cfg = vscode.workspace.getConfiguration('gitify');
    const configured = (cfg.get<string>('compareBase') || '').trim();
    if (configured) {
      await execPromise(`git rev-parse --verify ${configured}`, cwd);
      base = configured;
    }
  } catch {}
  for (const candidate of ['main', 'master']) {
    try {
      if (!base) {
        await execPromise(`git rev-parse --verify ${candidate}`, cwd);
        base = candidate; break;
      }
    } catch {}
  }

  let rangeExpr: string;
  if (base && base !== ref) {
    // Show commits unique to ref compared to base
    rangeExpr = `${sanitize(base)}..${sanitize(ref)}`;
  } else {
    rangeExpr = sanitize(ref);
  }

  const cmd = `git log --no-color --date=short --pretty=format:'${pretty}' -n ${n} "${rangeExpr}" --`;
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      const records = stdout.split('\x1e');
      const commits = records
        .map(r => r.trim())
        .filter(Boolean)
        .map(r => {
          const [fullHash, subject, author, date] = r.split('\x1f');
          const hash = (fullHash || '').slice(0, 7);
          return { hash, fullHash: fullHash || '', subject, author, date };
        });
      resolve(commits);
    });
  });
}

function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext) {
  const dist = vscode.Uri.joinPath(context.extensionUri, 'webview-ui', 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'assets', 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'assets', 'index.css'));

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} https:`,
    `script-src ${webview.cspSource}`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}">
  <title>Git DnD – Branches</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
