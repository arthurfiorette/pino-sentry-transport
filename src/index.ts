import type { Transform } from 'node:stream';
import type { Scope } from '@sentry/core';
import {
  type NodeOptions,
  type SeverityLevel,
  addBreadcrumb,
  captureException,
  captureMessage,
  getClient,
  init,
  logger
} from '@sentry/node';
import get from 'lodash.get';
import build from 'pino-abstract-transport';
import { writeFileSync } from 'node:fs';

const pinoLevelToSentryLevel = (level: number): SeverityLevel => {
  if (level === 60) {
    return 'fatal';
  }
  if (level >= 50) {
    return 'error';
  }
  if (level >= 40) {
    return 'warning';
  }
  if (level >= 30) {
    return 'log';
  }
  if (level >= 20) {
    return 'info';
  }
  return 'debug';
};

const pinoLevelToSentryKey = (level: number): keyof typeof logger => {
  if (level === 60) {
    return 'fatal';
  }
  if (level >= 50) {
    return 'error';
  }
  if (level >= 40) {
    return 'warn';
  }
  if (level >= 20) {
    return 'info';
  }
  return 'debug';
};

function deserializePinoError(pinoErr) {
  const { message, stack } = pinoErr;
  const newError = new Error(message);
  newError.stack = stack;
  return newError;
}

interface PinoSentryOptions {
  sentry: NodeOptions;
  minLevel: number;
  withLogRecord: boolean;
  tags: string[];
  context: string[];
  /**
   *  @deprecated This property is deprecated and should not be used. It is currently ignored and will be removed in the next major version. see docs.
   */
  skipSentryInitialization: boolean;

  expectPinoConfig: boolean;
  sendBreadcrumbs: boolean;
  useSentryLogger: boolean;
}

const defaultOptions: Partial<PinoSentryOptions> = {
  minLevel: 10,
  withLogRecord: false,
  skipSentryInitialization: false,
  expectPinoConfig: false
};

export default async function (initSentryOptions: Partial<PinoSentryOptions>) {
  const pinoSentryOptions = { ...defaultOptions, ...initSentryOptions };

  const client = getClient();
  const isInitialized = !!client;

  if (!isInitialized) {
    if (initSentryOptions.useSentryLogger) {
      pinoSentryOptions.sentry._experiments ??= {};
      pinoSentryOptions.sentry._experiments.enableLogs = true;
    }

    init(pinoSentryOptions.sentry);
  }

  writeFileSync('/tmp/debug', JSON.stringify(pinoSentryOptions, null, 2), 'utf8');

  function enrichScope(scope: Scope, pinoEvent) {
    scope.setLevel(pinoLevelToSentryLevel(pinoEvent.level));

    if (pinoSentryOptions.withLogRecord) {
      scope.setContext('pino-log-record', pinoEvent);
    }

    if (pinoSentryOptions.tags?.length) {
      for (const tag of pinoSentryOptions.tags) {
        scope.setTag(tag, get(pinoEvent, tag));
      }
    }

    if (pinoSentryOptions.context?.length) {
      const context = {};
      for (const c of pinoSentryOptions.context) {
        context[c] = get(pinoEvent, c);
      }
      scope.setContext('pino-context', context);
    }

    return scope;
  }

  return build(
    async (
      source: Transform & build.OnUnknown & { errorKey?: string; messageKey?: string }
    ) => {
      try {
        for await (const obj of source) {
          if (!obj) {
            return;
          }

          const serializedError = obj?.[source.errorKey ?? 'err'];
          const level = obj.level;

          if (level >= pinoSentryOptions.minLevel) {
            if (pinoSentryOptions.useSentryLogger) {
              const { trace_id, ...logData } = obj;
              const msg = logData[source.messageKey ?? 'msg'];
              delete logData[source.messageKey ?? 'msg'];
              if (trace_id) {
                logData.trace = trace_id;
              }

              logger[pinoLevelToSentryKey(level)](msg, logData);
            } else if (serializedError) {
              if (pinoSentryOptions.sendBreadcrumbs) {
                addBreadcrumb({
                  type: 'error',
                  level: pinoLevelToSentryLevel(level),
                  message: obj?.[source.messageKey ?? 'msg'],
                  data: obj
                });
              } else {
                captureException(deserializePinoError(serializedError), (scope) =>
                  enrichScope(scope, obj)
                );
              }
            } else {
              if (pinoSentryOptions.sendBreadcrumbs) {
                addBreadcrumb({
                  type: 'default',
                  level: pinoLevelToSentryLevel(level),
                  message: obj?.[source.messageKey ?? 'msg'],
                  data: obj
                });
              } else {
                captureMessage(obj?.[source.messageKey ?? 'msg'], (scope) =>
                  enrichScope(scope, obj)
                );
              }
            }
          }
        }
      } catch (err) {
        writeFileSync('/tmp/error', JSON.stringify(err, null, 2), 'utf8');
      }
    },
    { expectPinoConfig: pinoSentryOptions.expectPinoConfig }
  );
}
