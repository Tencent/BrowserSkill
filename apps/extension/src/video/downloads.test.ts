import { afterEach, expect, it, vi } from "vitest";
import { VideoDownloads } from "./downloads";
import type { VideoHost } from "./host-protocol";
import type { VideoManager } from "./manager";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const jobs: Record<string, unknown> = {};
  let changed!: (delta: { id: number }) => void;
  const status = { state: "in_progress" };
  const api = {
    downloads: {
      download: vi.fn(async () => 42),
      search: async () => [status],
      onChanged: {
        addListener: (listener: typeof changed) => {
          changed = listener;
        },
      },
    },
    storage: {
      session: {
        get: vi.fn(async (key: string | null) => (key ? { [key]: jobs[key] } : { ...jobs })),
        set: async (value: object) => Object.assign(jobs, value),
        remove: async (key: string) => {
          delete jobs[key];
        },
      },
    },
  };
  vi.stubGlobal("chrome", api);
  const video = {
    get: async () => ({ state: "ready", title: "Test", created_at: 0 }),
    exported: vi.fn(async () => {}),
  };
  const host = { request: vi.fn(async () => "blob:video") };
  const downloads = () =>
    new VideoDownloads(video as unknown as VideoManager, host as unknown as VideoHost);
  return { jobs, status, api, video, host, downloads, changed: () => changed({ id: 42 }) };
}

it("marks saved only on completion and recovers a persisted download after worker restart", async () => {
  const { downloads, video, jobs, status, changed } = fixture();
  const first = downloads();
  first.attach();
  await first.save("recording");
  expect(video.exported).not.toHaveBeenCalled();
  expect(Object.keys(jobs)).toHaveLength(1);
  status.state = "complete";
  downloads().attach();
  await vi.waitFor(() => expect(video.exported).toHaveBeenCalledWith("recording"));
  expect(Object.keys(jobs)).toHaveLength(0);
  status.state = "interrupted";
  await first.save("another");
  changed();
  expect(video.exported).toHaveBeenCalledTimes(1);
});

it("releases a completed download when its recording was deleted while Save As was open", async () => {
  const { downloads, video, host, jobs, status } = fixture();
  status.state = "complete";
  video.exported.mockRejectedValueOnce(new Error("recording deleted"));
  await downloads().save("deleted");
  expect(host.request).toHaveBeenLastCalledWith({ action: "revoke_url", url: "blob:video" });
  expect(Object.keys(jobs)).toHaveLength(0);
});

it("does not lose completion arriving before the download job is persisted", async () => {
  const { downloads, video, jobs, status, api, changed } = fixture();
  const first = downloads();
  first.attach();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  api.storage.session.get.mockImplementationOnce(async (key) => {
    const beforePersistence = { [key!]: jobs[key!] };
    await blocked;
    return beforePersistence;
  });
  api.downloads.download.mockImplementationOnce(async () => {
    status.state = "complete";
    changed();
    await Promise.resolve();
    return 42;
  });
  const saving = first.save("fast-download");
  await vi.waitFor(() => expect(Object.keys(jobs)).toHaveLength(1));
  release();
  await saving;
  expect(video.exported).toHaveBeenCalledExactlyOnceWith("fast-download");
  expect(Object.keys(jobs)).toHaveLength(0);
});
