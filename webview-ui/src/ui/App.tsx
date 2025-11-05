import React from 'react';
import { Box, Typography, List, ListItem, ListItemIcon, ListItemText, Chip, Stack, Card, CardContent, Button, Divider, Snackbar, Alert } from '@mui/material';
import CommitIcon from '@mui/icons-material/Commit';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';

type Branch = { name: string; current: boolean };
type Commit = { hash: string; fullHash?: string; subject: string; author: string; date: string };

declare global {
  interface VSCodeApi {
    postMessage: (msg: any) => void;
    setState: (state: any) => void;
    getState: () => any;
  }
  function acquireVsCodeApi(): VSCodeApi;
}

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {}, setState: () => {}, getState: () => ({}) } as VSCodeApi;

export default function App() {
  const [branches, setBranches] = React.useState<Branch[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = React.useState<string | null>(null);
  const [commits, setCommits] = React.useState<Commit[]>([]);
  const [loadingCommits, setLoadingCommits] = React.useState(false);
  const selectedBranchRef = React.useRef<string | null>(null);
  const lastRequestIdRef = React.useRef<number>(0);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<{ msg: string; severity: 'success' | 'error' } | null>(null);
  const [makingHead, setMakingHead] = React.useState<string | null>(null);

  React.useEffect(() => {
    const state = vscode.getState();
    if (state?.branches) setBranches(state.branches);

    const onMessage = (event: MessageEvent) => {
      const { type, payload } = event.data || {};
      if (type === 'branches') {
        setBranches(payload as Branch[]);
        vscode.setState({ branches: payload });
        if (!selectedBranchRef.current && Array.isArray(payload) && payload.length > 0) {
          const current = (payload as Branch[]).find(b => b.current) || (payload as Branch[])[0];
          setSelectedBranch(current.name);
          selectedBranchRef.current = current.name;
          setLoadingCommits(true);
          setCommits([]);
          const reqId = (lastRequestIdRef.current || 0) + 1;
          lastRequestIdRef.current = reqId;
          vscode.postMessage({ type: 'getCommits', branch: current.name, requestId: reqId });
        }
      } else if (type === 'error') {
        setError(String(payload));
        setLoadingCommits(false);
      } else if (type === 'commits') {
        const hasReq = typeof payload?.requestId === 'number';
        const isLatest = hasReq ? payload.requestId === lastRequestIdRef.current : true;
        if (payload?.branch === selectedBranchRef.current && isLatest) {
          setCommits(payload.commits as Commit[]);
          setLoadingCommits(false);
        }
      } else if (type === 'deleteResult') {
        if (payload?.branch === selectedBranchRef.current) {
          setDeleting(null);
          if (!payload.ok && payload.error) {
            setError(String(payload.error));
            setToast({ msg: String(payload.error), severity: 'error' });
          } else if (payload.ok && payload.message) {
            setToast({ msg: String(payload.message), severity: 'success' });
          }
        }
      } else if (type === 'makeHeadResult') {
        if (payload?.branch === selectedBranchRef.current) {
          setMakingHead(null);
          if (!payload.ok && payload.error) {
            setError(String(payload.error));
            setToast({ msg: String(payload.error), severity: 'error' });
          } else if (payload.ok && payload.message) {
            setToast({ msg: String(payload.message), severity: 'success' });
          }
        }
      }
    };
    window.addEventListener('message', onMessage);
    try { vscode.postMessage({ type: 'ready' }); } catch {}
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <Box py={3}>
      <Stack direction="row" alignItems="center" spacing={2} mb={2}>
        <Typography variant="h5" fontWeight={600}>Local Branches</Typography>
        <Chip label={`Total: ${branches.length}`} size="small" />
        {branches.length > 0 && !branches.some(b => b.current) && (
          <Chip label="Detached HEAD" size="small" color="warning" />
        )}
      </Stack>

      {error ? (
        <Card variant="outlined" sx={{ bgcolor: 'background.paper', borderColor: 'divider' }}>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom>
              {/not a git repository/i.test(error) ? 'Not a Git repository' : 'Unable to read branches'}
            </Typography>
            <Typography variant="body2" color="text.secondary" paragraph>
              {/not a git repository/i.test(error)
                ? 'Open a folder that contains a Git repository to view local branches.'
                : error}
            </Typography>
            <Button size="small" variant="contained" onClick={() => vscode.postMessage({ type: 'refresh' })}>
              Refresh
            </Button>
          </CardContent>
        </Card>
      ) : branches.length === 0 ? (
        <Card variant="outlined" sx={{ bgcolor: 'background.paper', borderColor: 'divider' }}>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom>
              No local branches yet
            </Typography>
            <Typography variant="body2" color="text.secondary" paragraph>
              Make your first commit to create the default branch.
            </Typography>
            <Button size="small" variant="contained" onClick={() => vscode.postMessage({ type: 'refresh' })}>
              Refresh
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Box>
          {toast && (
            <Snackbar open autoHideDuration={3000} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
              <Alert onClose={() => setToast(null)} severity={toast.severity} sx={{ width: '100%' }}>
                {toast.msg}
              </Alert>
            </Snackbar>
          )}
          <List dense>
            {branches.map((b) => (
              <ListItem
                key={b.name}
                button
                selected={selectedBranch === b.name}
                onClick={() => {
                  setSelectedBranch(b.name);
                  selectedBranchRef.current = b.name;
                  setLoadingCommits(true);
                  setCommits([]);
                  const reqId = (lastRequestIdRef.current || 0) + 1;
                  lastRequestIdRef.current = reqId;
                  vscode.postMessage({ type: 'getCommits', branch: b.name, requestId: reqId });
                }}
                sx={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
              >
                <ListItemIcon>
                  <CommitIcon color={b.current ? 'success' : 'disabled'} />
                </ListItemIcon>
                <ListItemText
                  primary={b.name}
                  secondary={b.current ? 'Current branch' : undefined}
                />
                {b.current && <Chip label="HEAD" size="small" color="success" />}
              </ListItem>
            ))}
          </List>

          {selectedBranch && (
            <Box mt={3}>
              <Typography variant="h6" gutterBottom>
                Commits on {selectedBranch}
              </Typography>
              <Divider sx={{ mb: 1 }} />
              {loadingCommits ? (
                <Typography variant="body2" color="text.secondary">Loading commits…</Typography>
              ) : commits.length === 0 ? (
                <Typography variant="body2" color="text.secondary">No commits found.</Typography>
              ) : (
                <List dense>
                  {commits.map((c, idx) => {
                    const isSelectedCurrent = branches.some(b => b.name === selectedBranch && b.current);
                    return (
                      <ListItem
                        key={c.hash}
                        sx={{ borderBottom: '1px solid rgba(255,255,255,0.06)', alignItems: 'flex-start' }}
                        secondaryAction={
                          <Stack direction="row" spacing={1}>
                            <Button
                              size="small"
                              variant="text"
                              color="inherit"
                              startIcon={<EmojiEventsIcon fontSize="small" />}
                              disabled={!!makingHead || !!deleting}
                              onClick={() => {
                                if (!selectedBranchRef.current) return;
                                setMakingHead(c.hash);
                                setToast({ msg: `Moving ${selectedBranchRef.current} to ${c.hash}…`, severity: 'success' });
                                try { console.log('Git DnD: makeHead click', { branch: selectedBranchRef.current, hash: c.hash, fullHash: c.fullHash }); } catch {}
                                const targetHash = c.fullHash || c.hash;
                                vscode.postMessage({ type: 'makeHead', branch: selectedBranchRef.current, hash: targetHash });
                              }}
                            >
                              Make HEAD
                            </Button>
                            <Button
                              size="small"
                              color="error"
                              disabled={!!deleting || !!makingHead}
                              onClick={() => {
                                if (!selectedBranchRef.current) return;
                                setDeleting(c.hash);
                                setToast({ msg: `Deleting ${c.hash} from ${selectedBranchRef.current}…`, severity: 'success' });
                                try { console.log('Git DnD: deleteCommit click', { branch: selectedBranchRef.current, hash: c.hash, fullHash: c.fullHash }); } catch {}
                                const targetHash = c.fullHash || c.hash;
                                vscode.postMessage({ type: 'deleteCommit', branch: selectedBranchRef.current, hash: targetHash });
                              }}
                            >
                              Delete
                            </Button>
                          </Stack>
                        }
                      >
                        <ListItemText
                          primary={
                            <Box display="flex" alignItems="center" gap={1}>
                              <span>{c.subject}</span>
                              {isSelectedCurrent && idx === 0 && <Chip label="HEAD" size="small" color="success" />}
                            </Box>
                          }
                          secondary={`${c.hash} • ${c.author} • ${c.date}`}
                        />
                      </ListItem>
                    );
                  })}
                </List>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
