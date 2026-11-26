/**
 * Website uploads through HCG Store's existing resumable upload pipeline (the same one HCG Executable Maker and HCG
 * Store Manager use): declare the file with its size and SHA-256, send it in Content-Range chunks to a short-lived
 * upload URL scoped to that one file, then ask HCG Store to verify it. The Store re-hashes the bytes it received and
 * checks the format and archive safety before the file becomes an immutable part of the draft; nothing is executed.
 *
 * Interruptions: each chunk is retried with back-off; on any doubt the Store is asked where to resume (it cuts off a
 * broken chunk), and an expired URL is renewed. A journal in this browser remembers unfinished uploads, so after a
 * reload or a crash the person picks the same file again and the upload continues where it stopped.
 */
import { adminApi, type AdminArtifact } from "./admin-api";
import { sha256OfBlob } from "./sha256";

export type UploadPhase = "queued" | "hashing" | "declaring" | "uploading" | "verifying" | "verified" | "rejected" | "paused" | "cancelled" | "failed";
export interface UploadProgress {
  phase: UploadPhase;
  hashed: number;
  sent: number;
  total: number;
  bytesPerSecond: number | null;
  secondsLeft: number | null;
  sha256: string | null;
  artifactId: string | null;
  artifact: AdminArtifact | null;
  message: string | null;
  retries: number;
}
export interface Declaration { platform: string; format: string; architectures: string[]; minimumOs: string | null }

const JOURNAL = "hcg-store.uploads";
export interface JournalEntry { artifactId: string; releaseId: string; fileName: string; size: number; lastModified: number; sha256: string; startedAt: number }

export function journal(): JournalEntry[] {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL) ?? "[]") as JournalEntry[];
  } catch {
    return [];
  }
}
function saveJournal(list: JournalEntry[]) {
  try {
    localStorage.setItem(JOURNAL, JSON.stringify(list));
  } catch {
    /* private window: uploads still work, they just cannot be resumed after a reload */
  }
}
export function forget(artifactId: string) {
  saveJournal(journal().filter((e) => e.artifactId !== artifactId));
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((ok, fail) => {
    const t = setTimeout(ok, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); fail(new DOMException("Cancelled", "AbortError")); }, { once: true });
  });

/** One chunk with real upload progress (fetch cannot report upload progress). */
function putChunk(url: string, blob: Blob, start: number, total: number, onBytes: (n: number) => void, signal: AbortSignal): Promise<{ status: number; body: { received?: number; error?: string | { code: string; message: string } } }> {
  return new Promise((ok, fail) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-range", `bytes ${start}-${start + blob.size - 1}/${total}`);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* not JSON */ }
      ok({ status: xhr.status, body });
    };
    xhr.onerror = () => fail(new Error("network"));
    xhr.ontimeout = () => fail(new Error("timeout"));
    const abort = () => { xhr.abort(); fail(new DOMException("Cancelled", "AbortError")); };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(blob);
  });
}

/**
 * Uploads one file to a draft release. `resumeArtifactId`: continue an interrupted upload of the SAME file (its
 * SHA-256 is checked against the one declared before any byte is sent).
 */
export async function uploadFile(
  file: File,
  releaseId: string,
  decl: Declaration,
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
  resumeArtifactId?: string,
): Promise<UploadProgress> {
  const p: UploadProgress = { phase: "hashing", hashed: 0, sent: 0, total: file.size, bytesPerSecond: null, secondsLeft: null, sha256: null, artifactId: resumeArtifactId ?? null, artifact: null, message: null, retries: 0 };
  const emit = (patch: Partial<UploadProgress>) => { Object.assign(p, patch); onProgress({ ...p }); };
  try {
    emit({});
    const sha256 = await sha256OfBlob(file, { signal, onProgress: (d) => emit({ hashed: d }) });
    emit({ sha256 });

    let url: string;
    let chunk: number;
    let received: number;
    if (resumeArtifactId) {
      const entry = journal().find((e) => e.artifactId === resumeArtifactId);
      if (entry && (entry.sha256 !== sha256 || entry.size !== file.size)) throw new Error("This is not the file whose upload was interrupted (its size or SHA-256 differs). Choose the same file.");
      const r = await adminApi.renewUploadUrl(resumeArtifactId);
      ({ uploadUrl: url, chunkBytes: chunk, received } = r);
    } else {
      emit({ phase: "declaring" });
      const d = await adminApi.declareArtifact(releaseId, { fileName: file.name, sizeBytes: file.size, sha256, ...decl });
      url = d.uploadUrl;
      chunk = d.chunkBytes;
      received = 0;
      emit({ artifactId: d.artifact.id });
      saveJournal([...journal().filter((e) => e.artifactId !== d.artifact.id), { artifactId: d.artifact.id, releaseId, fileName: file.name, size: file.size, lastModified: file.lastModified, sha256, startedAt: Date.now() }]);
    }

    emit({ phase: "uploading", sent: received });
    const startedAt = performance.now();
    const startedFrom = received;
    let failures = 0;
    while (received < file.size) {
      const end = Math.min(file.size, received + chunk);
      try {
        const r = await putChunk(url, file.slice(received, end), received, file.size, (n) => {
          const sent = received + n;
          const secs = (performance.now() - startedAt) / 1000;
          const rate = secs > 0.25 ? (sent - startedFrom) / secs : null;
          emit({ sent, bytesPerSecond: rate, secondsLeft: rate ? (file.size - sent) / rate : null });
        }, signal);
        if (r.status === 200) {
          received = end;
          failures = 0;
          emit({ sent: received });
          continue;
        }
        if (r.status === 409 && typeof r.body.received === "number") { received = r.body.received; continue; } // resume where the Store says
        if (r.status === 429) { await sleep(10_000, signal); continue; }
        if (r.status !== 403 && r.status < 500) throw new Error(typeof r.body.error === "object" ? r.body.error.message : `Upload refused (${r.status}).`);
        throw new Error("retry");
      } catch (e) {
        if ((e as DOMException).name === "AbortError") throw e;
        if ((e as Error).message !== "retry" && (e as Error).message !== "network" && (e as Error).message !== "timeout") throw e;
        failures += 1;
        emit({ retries: p.retries + 1, message: `Connection interrupted; retrying (${failures}/6)…` });
        if (failures > 6) throw new Error("The connection kept failing. The bytes already received are kept: resume later.");
        await sleep(Math.min(30_000, 500 * 2 ** failures), signal);
        // Ask the Store where to resume (a broken chunk is cut off) and get a fresh upload URL.
        const r = await adminApi.renewUploadUrl(p.artifactId!);
        ({ uploadUrl: url, received } = r);
        emit({ sent: received, message: null });
      }
    }

    emit({ phase: "verifying", sent: file.size, secondsLeft: 0 });
    const done = await adminApi.complete(p.artifactId!);
    forget(p.artifactId!);
    if (done.artifact.status === "verified") return emitDone({ phase: "verified", artifact: done.artifact, message: null });
    return emitDone({ phase: "rejected", artifact: done.artifact, message: done.message ?? (done.artifact.validation?.problems ?? []).join(" ") });
  } catch (e) {
    if ((e as DOMException).name === "AbortError") return emitDone({ phase: "paused", message: "Paused. The bytes already received are kept." });
    return emitDone({ phase: "failed", message: e instanceof Error ? e.message : "Upload failed." });
  }
  function emitDone(patch: Partial<UploadProgress>) {
    emit(patch);
    return { ...p };
  }
}

/** Cancel: stop and remove the unfinished file from the draft (a verified file is removed from the draft, kept on record). */
export async function cancelUpload(artifactId: string) {
  forget(artifactId);
  await adminApi.removeArtifact(artifactId);
}
