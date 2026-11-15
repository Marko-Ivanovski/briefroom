import { assertCompatible, normaliseAddress, request } from '../api.ts';
import type { Context } from '../context.ts';
import { saveWorkspaceToken } from '../credentials.ts';
import { CliError } from '../errors.ts';
import { offerPlugin } from '../plugin-install.ts';

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;

interface Started {
  code: string;
  approveUrl: string;
  pollToken: string;
  expiresAt?: string;
  interval?: number;
}

interface Approved {
  status: 'approved';
  token: string;
  workspaceId: string;
  workspaceName: string;
  installId: string;
}

const text = (v: unknown): v is string => typeof v === 'string' && v !== '';

async function startLogin(ctx: Context, baseUrl: string): Promise<Started> {
  const res = await request(ctx, baseUrl, '/api/v1/cli-login', {
    method: 'POST',
    body: { deviceName: ctx.hostname },
  });
  if (res.status === 429) throw new CliError('Too many login attempts. Wait a minute and retry.');
  const body = (await res.json().catch(() => null)) as Partial<Started> | null;
  if (!res.ok || !body || !text(body.code) || !text(body.approveUrl) || !text(body.pollToken)) {
    throw new CliError(`${baseUrl} did not start a login.`);
  }
  return body as Started;
}

export async function login(
  ctx: Context,
  address: string,
  options: { browser?: boolean } = {},
): Promise<void> {
  const baseUrl = normaliseAddress(address);
  const reportedInstallId = await assertCompatible(ctx, baseUrl);
  const started = await startLogin(ctx, baseUrl);

  ctx.out(
    `Open this page in your browser, sign in, and enter the code:\n  ${started.approveUrl}\nCode: ${started.code}\n`,
  );
  if (options.browser !== false) {
    await ctx.openUrl(started.approveUrl).catch(() => {
      ctx.out('Could not open a browser. Open the address above yourself.\n');
    });
  }

  const approved = await waitForApproval(ctx, baseUrl, started);
  // The address the user typed is the one that must have issued this token.
  if (reportedInstallId === null || approved.installId !== reportedInstallId) {
    throw new CliError(
      `${baseUrl} answered the login as a different install than it reported. Nothing was saved.`,
    );
  }
  await saveWorkspaceToken(
    ctx.home,
    { installId: approved.installId, baseUrl },
    approved.workspaceId,
    { name: approved.workspaceName, token: approved.token },
  );
  ctx.out(`Connected to ${approved.workspaceName} on ${new URL(baseUrl).host}.\n`);
  await offerPlugin(ctx);
}

async function waitForApproval(ctx: Context, baseUrl: string, started: Started): Promise<Approved> {
  const deadline = started.expiresAt
    ? Date.parse(started.expiresAt)
    : ctx.now() + DEFAULT_LOGIN_WINDOW_MS;
  const interval =
    typeof started.interval === 'number' && started.interval > 0
      ? started.interval * 1000
      : DEFAULT_INTERVAL_MS;
  let wait = interval;
  for (;;) {
    await ctx.sleep(wait);
    if (ctx.now() > deadline) throw expired();
    const res = await request(ctx, baseUrl, '/api/v1/cli-login/poll', {
      method: 'POST',
      body: { pollToken: started.pollToken },
    });
    if (res.status === 429) {
      wait = Math.min(wait * 2, MAX_BACKOFF_MS);
      continue;
    }
    wait = interval;
    if (!res.ok) throw new CliError(`${baseUrl} refused the login poll (HTTP ${res.status}).`);
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    if (body?.status === 'pending') continue;
    if (body?.status === 'approved') return approvedFrom(body as Partial<Approved>, baseUrl);
    throw expired();
  }
}

function approvedFrom(body: Partial<Approved>, baseUrl: string): Approved {
  if (
    !text(body.token) ||
    !text(body.workspaceId) ||
    !text(body.workspaceName) ||
    !text(body.installId)
  ) {
    throw new CliError(`${baseUrl} sent an incomplete login answer.`);
  }
  return body as Approved;
}

function expired(): CliError {
  return new CliError('The login expired or was not approved. Run briefroom login again.');
}
