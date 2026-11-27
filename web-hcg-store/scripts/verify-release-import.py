#!/usr/bin/env python3
"""Verifies a release import for HCG Store without changing any byte.

Checks the HCG Store draft (store-release-draft.json) against the import request, every downloaded file against the
draft (size, SHA-256), SHA256SUMS.txt, and every HCG Release Passport (hcg.release-passport v1) against its schema and
its file (size, SHA-256, SHA-512, source commit, run). Exits non-zero on any mismatch. Writes a JSON report.
"""
import argparse, hashlib, json, os, re, sys

ap = argparse.ArgumentParser()
ap.add_argument("--request", required=True)
ap.add_argument("--files", required=True)
ap.add_argument("--draft", required=True)
ap.add_argument("--schema", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()

problems = []
def check(ok, msg):
    if not ok:
        problems.append(msg)
    return ok

def digest(path, algo):
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

req = json.load(open(a.request, encoding="utf-8"))
check(req.get("format") == "hcg.store.release-import/1", "unknown import request format")
exp, src = req["expect"], req["source"]
draft_path = os.path.join(a.draft, "store-release-draft.json")
draft = json.load(open(draft_path, encoding="utf-8"))
rel, arts = draft["release"], draft["artifacts"]

for k in ("productId", "editionId", "version", "build", "channel", "distribution"):
    check(str(rel.get(k)) == str(exp[k]), f"draft {k} is {rel.get(k)!r}, the request expects {exp[k]!r}")
check(rel.get("eligibility") == "private", "the draft must be private until the owner approves publication")
check(rel.get("destinations") == ["hcg-store"], "the draft must target HCG Store only")
check(len(arts) == exp["files"], f"draft lists {len(arts)} files, the request expects {exp['files']}")
pinned = exp.get("sha256") or {}
check(len(pinned) == exp["files"], "the import request must pin the SHA-256 of every file (expect.sha256)")
check(sorted(pinned) == sorted(x["fileName"] for x in arts), "the pinned files differ from the files the draft lists")

present = sorted(f for f in os.listdir(a.files) if os.path.isfile(os.path.join(a.files, f)))
declared = sorted(x["fileName"] for x in arts)
extra = [f for f in present if f not in declared and f != "SHA256SUMS.txt"]
check(not extra, f"files in the artifact that the draft does not list: {extra}")

sums = {}
sums_path = os.path.join(a.files, "SHA256SUMS.txt")
if os.path.exists(sums_path):
    for line in open(sums_path, encoding="utf-8-sig"):
        m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$", line)
        if m:
            sums[m.group(2)] = m.group(1).lower()

# Files HCG Store verified and refused earlier: never imported, whatever their name.
rej_path = os.path.join(os.path.dirname(os.path.abspath(a.request)), "rejected-artifacts.json")
rejected = {r["sha256"] for r in json.load(open(rej_path, encoding="utf-8"))["rejected"]} if os.path.exists(rej_path) else set()

import jsonschema
schema = json.load(open(a.schema, encoding="utf-8"))
pass_dir = os.path.join(a.draft, "passports")
rows = []
for x in arts:
    name = x["fileName"]
    path = os.path.join(a.files, name)
    row = {"fileName": name, "architectures": x["architectures"], "format": x["format"], "kind": x.get("kind"),
           "declaredSize": x["sizeBytes"], "declaredSha256": x["sha256"], "minimumOs": x.get("minimumOs"),
           "signing": x["signing"]["status"], "sourceCommit": x.get("sourceCommit"), "buildProvider": x.get("buildProvider"),
           "toolchain": x.get("toolchain"), "validationPassed": (x.get("validationReport") or {}).get("passed")}
    if not check(os.path.exists(path), f"{name}: missing from the downloaded files"):
        rows.append(row); continue
    size, sha256, sha512 = os.path.getsize(path), digest(path, "sha256"), digest(path, "sha512")
    check(pinned.get(name) == sha256, f"{name}: SHA-256 {sha256} is not the one the committed import request pins")
    row.update(size=size, sha256=sha256, sha512=sha512)
    check(size == x["sizeBytes"], f"{name}: size {size}, draft says {x['sizeBytes']}")
    check(sha256 == x["sha256"], f"{name}: SHA-256 {sha256}, draft says {x['sha256']}")
    if sums:
        check(sums.get(name) == sha256, f"{name}: SHA256SUMS.txt says {sums.get(name)}")
    check(x.get("sourceCommit") == src["commit"], f"{name}: source commit {x.get('sourceCommit')}, request says {src['commit']}")
    check(x.get("platform") == exp.get("platform", "windows"), f"{name}: platform {x.get('platform')}, the request expects {exp.get('platform', 'windows')}")
    check(sha256 not in rejected, f"{name}: HCG Store refused this exact file earlier (rejected-artifacts.json)")
    pp = os.path.join(pass_dir, name + ".passport.json")
    if check(os.path.exists(pp), f"{name}: no Release Passport"):
        p = json.load(open(pp, encoding="utf-8"))
        try:
            jsonschema.validate(p, schema)
            row["passportSchema"] = "valid"
        except jsonschema.ValidationError as e:
            problems.append(f"{name}: passport does not match the schema: {e.message}")
            row["passportSchema"] = "invalid"
        art = p["artifact"]
        check(art["filename"] == name, f"{name}: passport names {art['filename']}")
        check(art["size"] == size, f"{name}: passport size {art['size']}")
        check(art["sha256"] == sha256, f"{name}: passport SHA-256 {art['sha256']}")
        check(art["sha512"] == sha512, f"{name}: passport SHA-512 differs")
        check(p["source"]["commit"] == src["commit"], f"{name}: passport source commit {p['source']['commit']}")
        check(int(p["build"]["run_id"]) == int(src["runId"]), f"{name}: passport run {p['build']['run_id']}")
        check(p["version"] == exp["version"], f"{name}: passport version {p['version']}")
        check(p["product"]["key"] == exp["productId"], f"{name}: passport product {p['product']['key']}")
        check(p["edition"] == exp["editionId"], f"{name}: passport edition {p['edition']}")
        row["passport"] = {
            "architecture": p["architecture"],
            "levels": {k: v["state"] for k, v in p["validation"]["levels"].items()},
            "runtimeCompatibility": p.get("runtime_compatibility"),
            "codeSigning": p["code_signing"]["all_signed"],
            "compatibilityStatus": p.get("compatibility_status"),
        }
    rows.append(row)

report = {"format": "hcg.store.release-import-verification/1", "request": req, "release": rel, "files": rows,
          "problems": problems, "verified": not problems}
os.makedirs(os.path.dirname(a.out), exist_ok=True)
json.dump(report, open(a.out, "w"), indent=2)

print(f"Release: {rel['productId']} / {rel['editionId']} {rel['version']} build {rel['build']} · channel {rel['channel']} · distribution {rel['distribution']}")
print(f"Source: {src['repository']} @ {src['commit']} · run {src['runId']}\n")
for r in rows:
    print(f"{r['fileName']}\n  size {r.get('size')} bytes · SHA-256 {r.get('sha256')}\n  signing: {r['signing']} · min OS: {r['minimumOs']} · passport: {r.get('passportSchema')} {json.dumps(r.get('passport', {}).get('levels'))}")
print()
summary = os.path.join(a.draft, "SUMMARY.md")
if os.path.exists(summary):
    print(open(summary, encoding="utf-8").read())
print("RELEASE NOTES:\n- " + "\n- ".join(rel["releaseNotes"]))
if problems:
    print("\nVERIFICATION FAILED:\n- " + "\n- ".join(problems))
    sys.exit(1)
print("\nVERIFIED: every file matches the draft, SHA256SUMS.txt and its Release Passport. No byte was changed.")
