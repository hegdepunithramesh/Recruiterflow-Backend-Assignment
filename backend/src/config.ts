export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly nodeEnv: 'development' | 'test' | 'production';
}

type ConfigField = 'DATABASE_URL' | 'PORT' | 'NODE_ENV';

export class ConfigurationError extends Error {
  constructor(readonly fields: ConfigField[]) {
    super('Invalid environment configuration. See the documented variable formats.');
    this.name = 'ConfigurationError';
  }
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const fields: ConfigField[] = [];
  const databaseUrl = env.DATABASE_URL ?? '';
  try {
    const url = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname || decodeURIComponent(url.username) !== 'recruiter_bot_app' || !url.password ||
      decodeURIComponent(url.pathname) !== '/recruiter_bot' ||
      url.search !== '' || url.hash !== '' ||
      (url.port !== '' && (!/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535))
    ) {
      fields.push('DATABASE_URL');
    }
  } catch {
    fields.push('DATABASE_URL');
  }

  const portText = env.PORT ?? '3000';
  const port = Number(portText);
  if (!/^[1-9][0-9]*$/.test(portText) || port > 65535) fields.push('PORT');
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    fields.push('NODE_ENV');
  }

  if (fields.length > 0) throw new ConfigurationError(fields);
  return { databaseUrl, port, nodeEnv: nodeEnv as Config['nodeEnv'] };
}
