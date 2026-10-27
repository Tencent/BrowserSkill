import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

interface FixtureTool {
  name: string;
  execute(args: object, exec: object): Promise<unknown>;
}

/** Exercise the packaged DSH tools against the fixture daemon, never the user's daemon. */
export async function createDshVideoFixture(
  executable: string,
  env: NodeJS.ProcessEnv,
  sessionStateDirectory: string,
) {
  const {
    createBskRunner,
    KeyedExecutor,
    ObservationService,
    registerBrowserTools,
    SessionRegistry,
  } = await import(
    new URL("../../../../packages/dsh-plugin-browserskill/lib/index.mjs", import.meta.url).href
  );
  const definitions = new Map<string, FixtureTool>();
  const ctx = {
    get: () => undefined,
    tools: {
      register: (definition: FixtureTool) => {
        definitions.set(definition.name, definition);
        return () => {
          definitions.delete(definition.name);
        };
      },
    },
  };
  const runner = createBskRunner(
    executable,
    (command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
      spawn(command, args, { ...options, env: { ...options?.env, ...env } }),
  );
  const registry = new SessionRegistry(2);
  const queue = new KeyedExecutor();
  const observation = new ObservationService({
    ctx,
    runner,
    registry,
    queue,
    options: { enabled: false, thumbnailIntervalMs: 1500, idleIntervalMs: 8000 },
  });
  const unregister = registerBrowserTools({
    ctx,
    runner,
    registry,
    queue,
    observation,
    config: {
      bskPath: executable,
      sessionStateDirectory,
      defaultTimeoutMs: 45000,
      maxSessions: 2,
      observationEnabled: false,
      thumbnailIntervalMs: 1500,
      idleIntervalMs: 8000,
      lazyTools: false,
    },
  });
  return {
    async call<T>(name: string, args: object): Promise<T> {
      const definition = definitions.get(name);
      if (!definition) throw new Error(`Missing packaged tool: ${name}`);
      return (await definition.execute(args, {
        callId: randomUUID(),
        name,
        signal: new AbortController().signal,
      })) as T;
    },
    async dispose() {
      unregister();
      runner.killAll();
      await observation.dispose();
    },
  };
}
