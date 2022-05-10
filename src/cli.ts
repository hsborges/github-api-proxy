#!/usr/bin/env node

/* Author: Hudson S. Borges */
import fastifyExpress from '@fastify/express';
import axios from 'axios';
import chalk from 'chalk';
import { Option, program } from 'commander';
import consola from 'consola';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { config } from 'dotenv-override-true';
import { EventEmitter } from 'events';
import statusMonitor from 'express-status-monitor';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'fs';
import { address } from 'ip';
import { compact, isNil, isObjectLike, omit, omitBy, uniq } from 'lodash';
import { resolve } from 'path';
import { Transform } from 'stream';
import { TableUserConfig, getBorderCharacters, table } from 'table';

import ProxyRouter, { ProxyRouterOpts, ProxyRouterResponse, WorkerLogger } from './router';

config({ path: resolve(__dirname, '.env.version') });
dayjs.extend(relativeTime);

export enum APIVersion {
  GraphQL = 'graphql',
  REST = 'rest'
}

export class ProxyLogTransform extends Transform {
  started = false;
  private config?: TableUserConfig;

  constructor() {
    super({ objectMode: true });

    this.config = {
      columnDefault: { alignment: 'right', width: 5 },
      columns: {
        0: { width: 5 },
        1: { width: 3 },
        2: { width: 5 },
        3: { width: 18 },
        4: { width: 4 },
        5: { width: 7 }
      },
      border: getBorderCharacters('void'),
      singleLine: true
    };
  }

  _transform(chunk: WorkerLogger, encoding: string, done: (error?: Error) => void): void {
    const data = {
      token: chunk.token,
      pending: chunk.pending,
      remaining: chunk.remaining,
      reset: dayjs.unix(chunk.reset).fromNow(),
      status: chalk[/(?![23])\d{3}/i.test(`${chunk.status}`) ? 'redBright' : 'green'](chunk.status),
      duration: `${chunk.duration / 1000}s`
    };

    if (!this.started) {
      this.started = true;
      this.push(
        chalk.bold('Columns: ') +
          Object.keys(data)
            .map((v) => chalk.underline(v))
            .join(', ') +
          '\n\n'
      );
    }

    this.push(table([Object.values(data)], this.config).trimEnd() + '\n');

    done();
  }
}

// parse tokens from input
export function parseTokens(text: string): string[] {
  return text
    .split(/\n/g)
    .map((v) => v.replace(/\s/g, ''))
    .reduce((acc: string[], v: string) => {
      if (!v || /^(\/{2}|#).*/gi.test(v)) return acc;
      return acc.concat([v.replace(/.*:(.+)/i, '$1')]);
    }, [])
    .reduce((acc: string[], token: string) => concatTokens(token, acc), []);
}

// concat tokens in commander
function concatTokens(token: string, list: string[]): string[] {
  if (token.length !== 40)
    throw new Error('Invalid access token detected (they have 40 characters)');
  return uniq([...list, token]);
}

// read tokens from a file
export function readTokensFile(filename: string): string[] {
  const filepath = resolve(process.cwd(), filename);
  if (!existsSync(filepath)) throw new Error(`File "${filename}" not found!`);
  return parseTokens(readFileSync(filepath, 'utf8'));
}

export type CliOpts = ProxyRouterOpts & {
  api: APIVersion;
  tokens: string[];
  silent?: boolean;
};

export function createProxyServer(options: CliOpts): FastifyInstance {
  const tokens = compact(options.tokens).reduce(
    (memo: string[], token: string) => concatTokens(token, memo),
    []
  );

  const fastify = Fastify({ logger: process.env.DEBUG == 'true' });

  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', {}, (req, payload, done) => done(null, req.body));

  fastify.register(fastifyExpress).after(() => {
    fastify.use(
      statusMonitor({
        healthChecks: [{ protocol: 'https', host: 'api.github.com', path: '/', port: 443 }]
      })
    );
  });

  const proxy = new ProxyRouter(tokens, options);

  const scheduler = (req: FastifyRequest, reply: FastifyReply) => {
    proxy.schedule(req, reply);
  };

  const defaultHandler = (req: FastifyRequest, res: FastifyReply) => {
    res
      .status(ProxyRouterResponse.PROXY_ERROR)
      .send({ message: `Endpoint not supported for "${options.api}" api.` });
  };

  fastify.route({
    method: ['DELETE', 'PATCH', 'PUT'],
    url: '/*',
    handler: defaultHandler
  });

  if (options.api === APIVersion.GraphQL) {
    fastify.post('/graphql', scheduler).get('/*', defaultHandler);
  } else {
    fastify.get('/*', scheduler).post('/*', defaultHandler);
  }

  if (!options.silent)
    proxy.pipe(new ProxyLogTransform().on('data', (data) => fastify.server.emit('log', data)));

  tokens.map((token) =>
    axios
      .get('https://api.github.com/user', {
        headers: {
          authorization: `token ${token}`,
          'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
        }
      })
      .catch((error) => {
        if (error.response?.status !== 401) return;
        proxy.removeToken(token);
        fastify.server.emit('warn', `Invalid token detected (${token}).`);
      })
  );

  return fastify;
}

// parse arguments from command line
if (require.main === module) {
  program
    .option(
      '-p, --port <port>',
      'Port to start the proxy server',
      Number,
      parseInt(process.env.PORT || '3000', 10)
    )
    .option('-t, --token <token>', 'GitHub token to be used', concatTokens, [])
    .addOption(
      new Option('--api <api>', 'API version to proxy requests')
        .choices(Object.values(APIVersion))
        .default(APIVersion.GraphQL)
        .argParser((value) => value.toLowerCase())
    )
    .addOption(
      new Option('--tokens <file>', 'File containing a list of tokens')
        .argParser(readTokensFile)
        .default(process.env.GPS_TOKENS_FILE)
    )
    .option(
      '--request-interval <interval>',
      'Interval between requests (ms)',
      Number,
      parseInt(process.env.GPS_REQUEST_INTERVAL || '250', 10)
    )
    .option(
      '--request-timeout <timeout>',
      'Request timeout (ms)',
      Number,
      parseInt(process.env.GPS_REQUEST_TIMEOUT || '20000', 10)
    )
    .option(
      '--min-remaining <number>',
      'Stop using token on',
      Number,
      parseInt(process.env.GPS_MIN_REMAINING || '100', 10)
    )
    .option(
      '--clustering',
      'Enable clustering mode (require redis)',
      [undefined, 'false'].indexOf(process.env.GPS_CLUSTERING) < 0
    )
    .option(
      '--clustering-redis-host <host>',
      '(clustering) redis host',
      process.env.GPS_CLUSTERING_REDIS_HOST || 'localhost'
    )
    .option(
      '--clustering-redis-port <port>',
      '(clustering) redis port',
      Number,
      parseInt(process.env.GPS_CLUSTERING_REDIS_PORT || '6379', 10)
    )
    .option(
      '--clustering-redis-db <db>',
      '(clustering) redis db',
      Number,
      parseInt(process.env.GPS_CLUSTERING_REDIS_PORT || '0', 10)
    )
    .option(
      '--silent',
      'Dont show requests outputs',
      [undefined, 'false'].indexOf(process.env.GPS_SILENT) < 0
    )
    .version(process.env.npm_package_version || '?', '-v, --version', 'output the current version')
    .parse();

  const options = program.opts();

  if (!options.token.length && !(options.tokens && options.tokens.length)) {
    consola.info(`${program.helpInformation()}`);
    consola.error(`Arguments missing ("--token" or "--tokens" is mandatory).\n\n`);
    process.exit(1);
  }

  EventEmitter.defaultMaxListeners = Number.MAX_SAFE_INTEGER;

  (async () => {
    const tokens = [...options.token, ...(options.tokens || [])].reduce(
      (memo: string[], token: string) => concatTokens(token, memo),
      []
    );

    const appOptions: CliOpts = {
      api: options.api,
      requestInterval: options.requestInterval,
      requestTimeout: options.requestTimeout,
      silent: options.silent,
      tokens: tokens,
      clustering: !options.clustering
        ? undefined
        : {
            host: options.clusteringRedisHost,
            port: options.clusteringRedisPort,
            db: options.clusteringRedisDb
          },
      minRemaining: options.minRemaining
    };

    const app = createProxyServer(appOptions);

    app.server
      .on('warn', consola.warn)
      .on('log', (data) => process.stdout.write(data.toString()))
      .on('listening', () => {
        const host = `http://${address()}:${options.port}`;
        consola.success(
          `Proxy server running on ${host} (tokens: ${chalk.greenBright(tokens.length)})`
        );

        function formatObject(object: Record<string, unknown>): string {
          return Object.entries(omitBy(object, (value) => isNil(value)))
            .sort((a: [string, unknown], b: [string, unknown]) => (a[0] > b[0] ? 1 : -1))
            .map(
              ([k, v]) =>
                `${k}: ${
                  isObjectLike(v)
                    ? `{ ${formatObject(v as Record<string, unknown>)} }`
                    : chalk.greenBright(v)
                }`
            )
            .join(', ');
        }

        consola.success(
          `${chalk.bold('Options')}: %s`,
          formatObject(omit(appOptions, ['token', 'tokens']))
        );
      })
      .on('error', (error) => {
        consola.error(error);
        app.server.close();
        process.exit(1);
      });

    await app.listen(options.port, '0.0.0.0');

    process.on('SIGTERM', async () => {
      consola.info('SIGTERM signal received: closing HTTP server');

      app
        .close()
        .finally(() => consola.success('Server closed'))
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  })();
}
