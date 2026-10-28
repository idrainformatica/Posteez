import { TemporalModule } from 'nestjs-temporal-core';
import {
  bundleWorkflowCode,
  type WorkflowBundleWithSourceMap,
} from '@temporalio/worker';
import { Connection } from '@temporalio/client';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';

const DEFAULT_TEMPORAL_GATE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TEMPORAL_GATE_RETRY_DELAY_MS = 5000;
const TEMPORAL_GATE_PROBE_TIMEOUT_MS = 10000;

const getConnectionOptions = () => ({
  isGlobal: true,
  connection: {
    address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    ...(process.env.TEMPORAL_TLS === 'true' ? { tls: true } : {}),
    ...(process.env.TEMPORAL_API_KEY
      ? { apiKey: process.env.TEMPORAL_API_KEY }
      : {}),
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  },
  taskQueue: 'main',
  logLevel: 'error' as const,
});

export const waitForTemporal = async () => {
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';
  const timeoutMs =
    Number(process.env.TEMPORAL_GATE_TIMEOUT_MS) ||
    DEFAULT_TEMPORAL_GATE_TIMEOUT_MS;
  const retryDelayMs =
    Number(process.env.TEMPORAL_GATE_RETRY_DELAY_MS) ||
    DEFAULT_TEMPORAL_GATE_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let connection: Connection | undefined;

    try {
      connection = await Connection.connect({
        address,
        ...(process.env.TEMPORAL_TLS === 'true' ? { tls: true } : {}),
        ...(process.env.TEMPORAL_API_KEY
          ? { apiKey: process.env.TEMPORAL_API_KEY }
          : {}),
      });

      await Promise.race([
        connection.workflowService.describeNamespace({ namespace }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('timeout')),
            TEMPORAL_GATE_PROBE_TIMEOUT_MS
          )
        ),
      ]);

      await connection.close().catch(() => {});
      return;
    } catch {
      await connection?.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    `Temporal at ${address} was not reachable within ${timeoutMs}ms`
  );
};

const getWorkerMode = () => {
  const mode = process.env.TEMPORAL_WORKER_MODE;

  if (!mode || mode === 'all') {
    return 'all';
  }

  if (mode === 'main') {
    return 'main';
  }

  throw new Error(
    `Unsupported TEMPORAL_WORKER_MODE "${mode}". Use "main" or "all".`
  );
};

const getWorkerDefinitions = (
  workflowBundle: WorkflowBundleWithSourceMap,
  activityClasses: any[],
  mode: 'main' | 'all'
) => {
  const excludeQueues = (process.env.EXCLUDE_QUEUE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const divider = Math.max(
    1,
    Number(process.env.WORKER_CONCURRENCY_DIVIDER) || 1
  );

  const integrations =
    mode === 'main'
      ? [{ identifier: 'main', maxConcurrentJob: undefined }]
      : [
          { identifier: 'main', maxConcurrentJob: undefined },
          ...socialIntegrationList,
        ];

  return integrations
    .filter((integration) => integration.identifier.indexOf('-') === -1)
    .map((integration) => ({
      integration,
      taskQueue: integration.identifier.split('-')[0],
    }))
    .filter(({ taskQueue }) => !excludeQueues.includes(taskQueue))
    .map(({ integration, taskQueue }) => {
      const concurrency = integration.maxConcurrentJob
        ? Math.max(1, Math.floor(integration.maxConcurrentJob / divider))
        : undefined;

      return {
        taskQueue,
        workflowBundle: workflowBundle as unknown as Record<string, unknown>,
        activityClasses,
        autoStart: true,
        ...(concurrency
          ? {
              workerOptions: {
                maxConcurrentActivityTaskExecutions: concurrency,
              },
            }
          : {
              workerOptions: {
                maxConcurrentActivityTaskExecutions: 1000000,
              },
            }),
      };
    });
};

export const getTemporalModule = (
  isWorkers: boolean,
  path?: string,
  activityClasses?: any[]
) => {
  if (!isWorkers) {
    return TemporalModule.register(getConnectionOptions());
  }

  return TemporalModule.registerAsync({
    isGlobal: true,
    useFactory: async () => {
      if (!path) {
        throw new Error(
          'A workflows path is required when workers are enabled.'
        );
      }

      const mode = getWorkerMode();
      const workflowBundle = await bundleWorkflowCode({
        workflowsPath: path,
      });

      return {
        ...getConnectionOptions(),
        workers: getWorkerDefinitions(
          workflowBundle,
          activityClasses || [],
          mode
        ),
      };
    },
  });
};
