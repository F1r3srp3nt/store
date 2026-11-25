/**
 * Generates the HCG Store-approved part of `catalogue/releases.json` from exported release records
 * (release-records.ts). Entries with `source.kind = "hcg-store-approval"` are owned by this generator: they are
 * replaced on every run. Entries without a source (added by hand) are kept unchanged.
 *
 * Rules:
 * - Only products in the catalogue with a confirmed central product ID, and only editions the product has.
 * - Records of the same product and version (several editions or builds) become one catalogue release, since the
 *   catalogue allows one release per version. It is approved while any of its records is approved; files of
 *   withdrawn records are left out.
 * - `currentReleaseId` changes only when an approver chose "make current" at approval (never the newest version),
 *   and is cleared when the release it points to was generated and is now withdrawn.
 * - Signing results are what the uploading tool reported; the Store never verified them, and the entry says so.
 * - No file location or download URL is written.
 */
import type { Release } from "../../src/domain/schema";
import { RELEASE_RECORDS_FORMAT, type ReleaseRecord, type ReleaseRecordsExport } from "./release-records";

export interface SyncProduct {
  id: string;
  centralId: string | null;
  editionIds: string[];
  currentReleaseId: string | null;
}

export interface SyncResult {
  releases: Release[];
  currentReleaseIds: Record<string, string | null>;
  notes: string[];
  skipped: string[];
}

const SIGNING = new Set(["unsigned", "signed", "notarized"]);
const CHANNELS = new Set(["alpha", "beta", "stable"]);

export function syncReleases(existing: Release[], products: SyncProduct[], exported: ReleaseRecordsExport): SyncResult {
  if (exported.format !== RELEASE_RECORDS_FORMAT) throw new Error(`Unknown release-records format: ${String(exported.format)}`);
  if (!exported.auditIntact) throw new Error("HCG Store's publishing audit chain does not verify. Nothing was generated.");
  const notes: string[] = [];
  const skipped: string[] = [];
  const byProduct = new Map(products.map((p) => [p.id, p]));
  const usable: ReleaseRecord[] = [];
  for (const r of exported.records) {
    const p = byProduct.get(r.productId);
    if (!p) skipped.push(`${r.storeReleaseId}: product ${r.productId} is not in the catalogue.`);
    else if (!p.centralId) skipped.push(`${r.storeReleaseId}: ${r.productId} has no central product ID.`);
    else if (p.editionIds.length ? !r.editionId || !p.editionIds.includes(r.editionId) : r.editionId !== null) skipped.push(`${r.storeReleaseId}: edition ${r.editionId} is not an edition of ${r.productId}.`);
    else if (!CHANNELS.has(r.channel)) skipped.push(`${r.storeReleaseId}: channel ${r.channel} is not a catalogue channel.`);
    else usable.push(r);
  }

  // One catalogue release per product and version.
  const groups = new Map<string, ReleaseRecord[]>();
  for (const r of usable) {
    const k = `${r.productId}\u0000${r.version}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const manual = existing.filter((x) => x.source?.kind !== "hcg-store-approval");
  const generated: Release[] = [];
  for (const records of groups.values()) {
    records.sort((a, b) => a.approvedAt - b.approvedAt || a.storeReleaseId.localeCompare(b.storeReleaseId));
    const first = records[0]!;
    const clash = manual.find((m) => m.productId === first.productId && m.version === first.version);
    if (clash) {
      skipped.push(`${records.map((r) => r.storeReleaseId).join(", ")}: ${first.productId} ${first.version} already has a hand-written release (${clash.id}).`);
      continue;
    }
    const live = records.filter((r) => r.status === "approved");
    const rel: Release = {
      id: first.storeReleaseId,
      productId: first.productId,
      version: first.version,
      build: records.map((r) => r.build).join(", "),
      channel: ((live[0] ?? first).channel) as Release["channel"],
      status: live.length ? "approved" : "withdrawn",
      withdrawnReason: live.length ? null : records.map((r) => r.withdrawnReason ?? "Withdrawn in HCG Store.").join(" "),
      releaseDate: new Date((live[0] ?? first).publishedAt ?? (live[0] ?? first).approvedAt).toISOString().slice(0, 10),
      releaseNotes: [...new Set(records.flatMap((r) => r.releaseNotes))],
      knownLimitations: [],
      artifacts: (live.length ? live : []).flatMap((r) =>
        r.artifacts.map((a) => ({
          id: a.id,
          platform: a.platform as Release["artifacts"][number]["platform"],
          architectures: a.architectures,
          fileName: a.fileName,
          format: a.format as Release["artifacts"][number]["format"],
          sizeBytes: a.sizeBytes,
          sha256: a.sha256,
          minimumOs: a.minimumOs,
          signing: signing(a.signingReported),
          editionId: r.editionId,
          sourceCommit: a.provenance?.sourceCommit ?? null,
          buildProvider: (a.provenance?.buildProvider ?? null) as Release["artifacts"][number]["buildProvider"],
          toolchain: a.provenance?.toolchain ?? null,
        })),
      ),
      source: {
        kind: "hcg-store-approval",
        approvals: records.map((r) => ({
          storeReleaseId: r.storeReleaseId,
          editionId: r.editionId,
          build: r.build,
          approvedAt: new Date(r.approvedAt).toISOString(),
          approvalAudit: r.approvalAudit,
        })),
      },
    };
    generated.push(rel);
  }

  // currentReleaseId: only the approver's explicit choice.
  const releaseOf = new Map<string, Release>();
  for (const g of generated) for (const a of g.source!.approvals) releaseOf.set(a.storeReleaseId, g);
  const currentReleaseIds: Record<string, string | null> = {};
  for (const p of products) {
    const chosen = usable
      .filter((r) => r.productId === p.id && r.current && r.status === "approved" && releaseOf.has(r.storeReleaseId))
      .sort((a, b) => b.approvedAt - a.approvedAt)[0];
    let next = p.currentReleaseId;
    if (chosen) next = releaseOf.get(chosen.storeReleaseId)!.id;
    const pointed = next ? generated.find((g) => g.id === next) : undefined;
    const wasGenerated = next && existing.some((x) => x.id === next && x.source?.kind === "hcg-store-approval");
    if (next && !pointed && wasGenerated) next = null; // a generated release that no longer exists
    if (pointed && pointed.status === "withdrawn") next = null;
    if (next !== p.currentReleaseId) {
      currentReleaseIds[p.id] = next;
      notes.push(`${p.id}: current release ${p.currentReleaseId ?? "none"} → ${next ?? "none"}${chosen ? " (approver's choice)" : " (withdrawn)"}.`);
    }
  }
  const releases = [...manual, ...generated.sort((a, b) => a.productId.localeCompare(b.productId) || a.id.localeCompare(b.id))];
  return { releases, currentReleaseIds, notes, skipped };
}

function signing(s: { status: string; evidence: string | null; tool: string | null }): Release["artifacts"][number]["signing"] {
  if (!SIGNING.has(s.status)) return { status: "not-stated", evidence: null };
  const by = s.tool ? ` by ${s.tool}` : "";
  const evidence = s.status === "unsigned" ? null : `Reported${by} at upload; not verified by HCG Store.${s.evidence ? ` ${s.evidence.slice(0, 500)}` : ""}`;
  return { status: s.status as "unsigned" | "signed" | "notarized", evidence };
}
