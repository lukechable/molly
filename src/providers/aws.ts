import {
  CreateAccessKeyCommand,
  DeleteAccessKeyCommand,
  GetAccessKeyLastUsedCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListUsersCommand,
} from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { cliLogin } from './cli.js';
import { eventually, pairedDetector } from './common.js';
import type { Provider, ProviderContext } from './types.js';

async function iam(ctx: ProviderContext) {
  const profile = await ctx.authOptional('profile');
  return new IAMClient({ region: 'us-east-1', ...(profile ? { profile } : {}) });
}

export const aws: Provider = {
  id: 'aws',
  name: 'AWS',
  category: 'cloud',
  mode: 'auto',
  blurb: 'Creates a new IAM access key, deletes the old one',
  fields: ['access_key_id', 'secret_access_key'],
  dashboardUrl: 'https://console.aws.amazon.com/iam/home#/users',
  cliLogin: cliLogin('AWS CLI', 'aws', ['login']),
  auth: [
    {
      key: 'profile',
      label: 'AWS profile to rotate with',
      secret: false,
      optional: true,
      help: 'Leave blank to use your default AWS credentials. Needs iam:*AccessKey* permissions.',
    },
  ],
  async checkAuth(ctx) {
    const profile = await ctx.authOptional('profile');
    const sts = new STSClient({ region: 'us-east-1', ...(profile ? { profile } : {}) });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    return id.Arn ?? id.Account ?? 'connected';
  },
  detect: pairedDetector(
    'aws',
    'access_key_id',
    'secret_access_key',
    /^AKIA[0-9A-Z]{16}$/,
    /ACCESS_KEY_ID$/,
    (k) => [k.replace(/ACCESS_KEY_ID$/, 'SECRET_ACCESS_KEY'), k.replace(/ACCESS_KEY_ID$/, 'SECRET_KEY')],
  ),
  async prepare(ctx, cred, current) {
    if (cred.params.user) return;
    const client = await iam(ctx);
    try {
      const res = await client.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: current.access_key_id }));
      if (res.UserName) {
        cred.params.user = res.UserName;
        cred.state.keyId = current.access_key_id;
        cred.label = `${cred.label} (${res.UserName})`;
        return;
      }
    } catch {}
    const users = await client.send(new ListUsersCommand({ MaxItems: 200 }));
    return [
      {
        param: 'user',
        prompt: `Which IAM user owns ${cred.label}?`,
        options: (users.Users ?? []).map((u) => ({ label: u.UserName!, value: u.UserName! })),
      },
    ];
  },
  async resolveKeyId(_ctx, _cred, current) {
    return current.access_key_id;
  },
  async issue(ctx, cred, currentKeyId) {
    const client = await iam(ctx);
    const UserName = cred.params.user;
    const existing = await client.send(new ListAccessKeysCommand({ UserName }));
    const others = (existing.AccessKeyMetadata ?? []).filter((k) => k.AccessKeyId !== currentKeyId);
    if ((existing.AccessKeyMetadata?.length ?? 0) >= 2) {
      throw new Error(
        `IAM user ${UserName} already has 2 access keys (AWS max). Delete the unused one (${others[0]?.AccessKeyId}) first.`,
      );
    }
    const res = await client.send(new CreateAccessKeyCommand({ UserName }));
    const key = res.AccessKey!;
    return {
      keyId: key.AccessKeyId!,
      values: { access_key_id: key.AccessKeyId!, secret_access_key: key.SecretAccessKey! },
    };
  },
  async revoke(ctx, cred, keyId) {
    const client = await iam(ctx);
    await client.send(new DeleteAccessKeyCommand({ UserName: cred.params.user, AccessKeyId: keyId }));
  },
  async verify(_ctx, _cred, values) {
    // New IAM keys take a few seconds to propagate.
    await eventually(async () => {
      const sts = new STSClient({
        region: 'us-east-1',
        credentials: { accessKeyId: values.access_key_id, secretAccessKey: values.secret_access_key },
      });
      await sts.send(new GetCallerIdentityCommand({}));
    });
  },
};
