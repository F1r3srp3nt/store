PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     email TEXT,
     name TEXT,
     refresh_token TEXT,
     access_token TEXT,
     access_expires_at INTEGER NOT NULL,
     central_checked_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     ended_at INTEGER,
     ended_reason TEXT
   , account_confirmed_at INTEGER);
CREATE INDEX sessions_sub ON sessions(sub);
CREATE TABLE login_attempts (
     state TEXT PRIMARY KEY,
     verifier TEXT NOT NULL,
     nonce TEXT NOT NULL,
     return_to TEXT NOT NULL,
     purpose TEXT NOT NULL,
     purpose_data TEXT,
     created_at INTEGER NOT NULL
   );
CREATE TABLE checkout_sessions (
     id TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     offer_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     currency TEXT NOT NULL,
     status TEXT NOT NULL,
     provider TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
CREATE TABLE purchases (
     id TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     offer_id TEXT NOT NULL,
     checkout_id TEXT NOT NULL UNIQUE,
     provider TEXT NOT NULL,
     provider_payment_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     currency TEXT NOT NULL,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     current_period_end INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(provider, provider_payment_id)
   );
CREATE INDEX purchases_sub ON purchases(sub);
CREATE TABLE payment_events (
     provider TEXT NOT NULL,
     event_id TEXT NOT NULL,
     type TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     outcome TEXT NOT NULL,
     PRIMARY KEY (provider, event_id)
   );
CREATE TABLE test_entitlements (
     sub TEXT NOT NULL,
     product_id TEXT NOT NULL,
     edition TEXT NOT NULL,
     source TEXT NOT NULL,
     status TEXT NOT NULL,
     expires_at INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (sub, product_id, edition, source)
   );
CREATE TABLE repo_tokens (
     token_hash TEXT PRIMARY KEY,
     secret_hash TEXT NOT NULL,
     session_id_hash TEXT NOT NULL,
     sub TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   );
CREATE TABLE checkout_reversals (
     checkout_id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     received_at INTEGER NOT NULL
   );
CREATE TABLE central_grants (
     purchase_key TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     product_id TEXT NOT NULL,
     edition TEXT,
     state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
     reason TEXT,
     starts_at INTEGER NOT NULL,
     ends_at INTEGER,
     revision INTEGER NOT NULL,
     delivered_revision INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     updated_at INTEGER NOT NULL
   , features TEXT NOT NULL DEFAULT '[]');
CREATE INDEX central_grants_pending ON central_grants(next_attempt_at) WHERE delivered_revision < revision;
CREATE TABLE pub_products (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
CREATE TABLE pub_releases (
     id TEXT PRIMARY KEY,
     product_id TEXT NOT NULL,
     product_source TEXT NOT NULL,
     edition_id TEXT,
     version TEXT NOT NULL,
     build TEXT NOT NULL,
     channel TEXT NOT NULL,
     release_notes TEXT NOT NULL,
     compatibility TEXT NOT NULL,
     distribution TEXT NOT NULL,
     requested_eligibility TEXT NOT NULL,
     destinations TEXT NOT NULL,
     status TEXT NOT NULL,
     approved_eligibility TEXT,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     submitted_at INTEGER,
     approved_by TEXT,
     approved_at INTEGER,
     withdrawn_reason TEXT,
     UNIQUE (product_id, edition_id, version, build)
   );
CREATE TABLE pub_artifacts (
     id TEXT PRIMARY KEY,
     release_id TEXT NOT NULL REFERENCES pub_releases(id),
     file_name TEXT NOT NULL,
     platform TEXT NOT NULL,
     format TEXT NOT NULL,
     architectures TEXT NOT NULL,
     minimum_os TEXT,
     size_bytes INTEGER NOT NULL,
     declared_sha256 TEXT NOT NULL,
     sha256 TEXT,
     status TEXT NOT NULL,
     storage_key TEXT,
     content_type TEXT NOT NULL,
     validation TEXT,
     signing_reported TEXT NOT NULL,
     package TEXT,
     created_at INTEGER NOT NULL,
     completed_at INTEGER, declared_kind TEXT,
     UNIQUE (release_id, file_name)
   );
CREATE TABLE pub_uploads (
     artifact_id TEXT PRIMARY KEY REFERENCES pub_artifacts(id),
     received_bytes INTEGER NOT NULL,
     staging_key TEXT NOT NULL,
     attempts INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
CREATE TABLE pub_download_grants (
     id_hash TEXT PRIMARY KEY,
     sub TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     access_token TEXT,
     expires_at INTEGER NOT NULL
   );
CREATE TABLE pub_audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     release_id TEXT,
     artifact_id TEXT,
     detail TEXT NOT NULL,
     prev_hash TEXT NOT NULL,
     hash TEXT NOT NULL
   );
CREATE TRIGGER pub_audit_no_update BEFORE UPDATE ON pub_audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER pub_audit_no_delete BEFORE DELETE ON pub_audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER pub_artifact_immutable BEFORE UPDATE ON pub_artifacts
     WHEN OLD.status = 'verified' AND (NEW.sha256 IS NOT OLD.sha256 OR NEW.storage_key IS NOT OLD.storage_key OR NEW.size_bytes IS NOT OLD.size_bytes
          OR NEW.file_name IS NOT OLD.file_name OR NEW.release_id IS NOT OLD.release_id OR NEW.status NOT IN ('verified', 'removed'))
     BEGIN SELECT RAISE(ABORT, 'verified artifacts are immutable'); END;
CREATE TRIGGER pub_artifact_no_delete BEFORE DELETE ON pub_artifacts WHEN OLD.status IN ('verified', 'removed')
     BEGIN SELECT RAISE(ABORT, 'verified artifacts are never deleted'); END;
CREATE UNIQUE INDEX pub_releases_one_per_build ON pub_releases (product_id, COALESCE(edition_id, ''), version, build);
CREATE TABLE auth_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     type TEXT NOT NULL,
     session_ref TEXT,
     sub TEXT,
     detail TEXT
   );
CREATE INDEX auth_events_at ON auth_events(at);
CREATE TABLE store_profiles (
     sub TEXT PRIMARY KEY,
     display_name TEXT,
     designation TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
CREATE TABLE store_profile_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     sub TEXT NOT NULL,
     action TEXT NOT NULL,
     before_json TEXT,
     after_json TEXT NOT NULL,
     authorised_by TEXT NOT NULL,
     performed_by TEXT NOT NULL
   );
CREATE TRIGGER store_profile_events_no_update BEFORE UPDATE ON store_profile_events BEGIN SELECT RAISE(ABORT, 'profile events are append-only'); END;
CREATE TRIGGER store_profile_events_no_delete BEFORE DELETE ON store_profile_events BEGIN SELECT RAISE(ABORT, 'profile events are append-only'); END;
INSERT INTO schema_version (version) VALUES (7);
INSERT INTO sessions (id_hash,sub,email,name,refresh_token,access_token,access_expires_at,central_checked_at,created_at,last_seen_at,ended_at,ended_reason,account_confirmed_at) VALUES ('sessions-id_hash-0','sessions-sub-0','sessions-email-0','sessions-name-0','sessions-refresh_token-0','sessions-access_token-0',1764000000000,1764000000000,1764000000000,1764000000000,1764000000000,'sessions-ended_reason-0',1764000000000);
INSERT INTO sessions (id_hash,sub,email,name,refresh_token,access_token,access_expires_at,central_checked_at,created_at,last_seen_at,ended_at,ended_reason,account_confirmed_at) VALUES ('sessions-id_hash-1','sessions-sub-1','sessions-email-1','sessions-name-1','sessions-refresh_token-1','sessions-access_token-1',1764000000001,1764000000001,1764000000001,1764000000001,1764000000001,'sessions-ended_reason-1',1764000000001);
INSERT INTO sessions (id_hash,sub,email,name,refresh_token,access_token,access_expires_at,central_checked_at,created_at,last_seen_at,ended_at,ended_reason,account_confirmed_at) VALUES ('sessions-id_hash-2','sessions-sub-2','sessions-email-2','sessions-name-2','sessions-refresh_token-2','sessions-access_token-2',1764000000002,1764000000002,1764000000002,1764000000002,1764000000002,'sessions-ended_reason-2',1764000000002);
INSERT INTO login_attempts (state,verifier,nonce,return_to,purpose,purpose_data,created_at) VALUES ('login_attempts-state-0','login_attempts-verifier-0','login_attempts-nonce-0','login_attempts-return_to-0','login_attempts-purpose-0','login_attempts-purpose_data-0',1764000000000);
INSERT INTO login_attempts (state,verifier,nonce,return_to,purpose,purpose_data,created_at) VALUES ('login_attempts-state-1','login_attempts-verifier-1','login_attempts-nonce-1','login_attempts-return_to-1','login_attempts-purpose-1','login_attempts-purpose_data-1',1764000000001);
INSERT INTO login_attempts (state,verifier,nonce,return_to,purpose,purpose_data,created_at) VALUES ('login_attempts-state-2','login_attempts-verifier-2','login_attempts-nonce-2','login_attempts-return_to-2','login_attempts-purpose-2','login_attempts-purpose_data-2',1764000000002);
INSERT INTO checkout_sessions (id,sub,offer_id,amount,currency,status,provider,created_at,updated_at) VALUES ('checkout_sessions-id-0','checkout_sessions-sub-0','checkout_sessions-offer_id-0',1764000000000,'checkout_sessions-currency-0','checkout_sessions-status-0','checkout_sessions-provider-0',1764000000000,1764000000000);
INSERT INTO checkout_sessions (id,sub,offer_id,amount,currency,status,provider,created_at,updated_at) VALUES ('checkout_sessions-id-1','checkout_sessions-sub-1','checkout_sessions-offer_id-1',1764000000001,'checkout_sessions-currency-1','checkout_sessions-status-1','checkout_sessions-provider-1',1764000000001,1764000000001);
INSERT INTO checkout_sessions (id,sub,offer_id,amount,currency,status,provider,created_at,updated_at) VALUES ('checkout_sessions-id-2','checkout_sessions-sub-2','checkout_sessions-offer_id-2',1764000000002,'checkout_sessions-currency-2','checkout_sessions-status-2','checkout_sessions-provider-2',1764000000002,1764000000002);
INSERT INTO purchases (id,sub,offer_id,checkout_id,provider,provider_payment_id,amount,currency,kind,status,current_period_end,created_at,updated_at) VALUES ('purchases-id-0','purchases-sub-0','purchases-offer_id-0','purchases-checkout_id-0','purchases-provider-0','purchases-provider_payment_id-0',1764000000000,'purchases-currency-0','purchases-kind-0','purchases-status-0',1764000000000,1764000000000,1764000000000);
INSERT INTO purchases (id,sub,offer_id,checkout_id,provider,provider_payment_id,amount,currency,kind,status,current_period_end,created_at,updated_at) VALUES ('purchases-id-1','purchases-sub-1','purchases-offer_id-1','purchases-checkout_id-1','purchases-provider-1','purchases-provider_payment_id-1',1764000000001,'purchases-currency-1','purchases-kind-1','purchases-status-1',1764000000001,1764000000001,1764000000001);
INSERT INTO purchases (id,sub,offer_id,checkout_id,provider,provider_payment_id,amount,currency,kind,status,current_period_end,created_at,updated_at) VALUES ('purchases-id-2','purchases-sub-2','purchases-offer_id-2','purchases-checkout_id-2','purchases-provider-2','purchases-provider_payment_id-2',1764000000002,'purchases-currency-2','purchases-kind-2','purchases-status-2',1764000000002,1764000000002,1764000000002);
INSERT INTO payment_events (provider,event_id,type,received_at,outcome) VALUES ('payment_events-provider-0','payment_events-event_id-0','payment_events-type-0',1764000000000,'payment_events-outcome-0');
INSERT INTO payment_events (provider,event_id,type,received_at,outcome) VALUES ('payment_events-provider-1','payment_events-event_id-1','payment_events-type-1',1764000000001,'payment_events-outcome-1');
INSERT INTO payment_events (provider,event_id,type,received_at,outcome) VALUES ('payment_events-provider-2','payment_events-event_id-2','payment_events-type-2',1764000000002,'payment_events-outcome-2');
INSERT INTO test_entitlements (sub,product_id,edition,source,status,expires_at,updated_at) VALUES ('test_entitlements-sub-0','test_entitlements-product_id-0','test_entitlements-edition-0','test_entitlements-source-0','test_entitlements-status-0',1764000000000,1764000000000);
INSERT INTO test_entitlements (sub,product_id,edition,source,status,expires_at,updated_at) VALUES ('test_entitlements-sub-1','test_entitlements-product_id-1','test_entitlements-edition-1','test_entitlements-source-1','test_entitlements-status-1',1764000000001,1764000000001);
INSERT INTO test_entitlements (sub,product_id,edition,source,status,expires_at,updated_at) VALUES ('test_entitlements-sub-2','test_entitlements-product_id-2','test_entitlements-edition-2','test_entitlements-source-2','test_entitlements-status-2',1764000000002,1764000000002);
INSERT INTO repo_tokens (token_hash,secret_hash,session_id_hash,sub,created_at,revoked_at) VALUES ('repo_tokens-token_hash-0','repo_tokens-secret_hash-0','repo_tokens-session_id_hash-0','repo_tokens-sub-0',1764000000000,1764000000000);
INSERT INTO repo_tokens (token_hash,secret_hash,session_id_hash,sub,created_at,revoked_at) VALUES ('repo_tokens-token_hash-1','repo_tokens-secret_hash-1','repo_tokens-session_id_hash-1','repo_tokens-sub-1',1764000000001,1764000000001);
INSERT INTO repo_tokens (token_hash,secret_hash,session_id_hash,sub,created_at,revoked_at) VALUES ('repo_tokens-token_hash-2','repo_tokens-secret_hash-2','repo_tokens-session_id_hash-2','repo_tokens-sub-2',1764000000002,1764000000002);
INSERT INTO checkout_reversals (checkout_id,type,received_at) VALUES ('checkout_reversals-checkout_id-0','checkout_reversals-type-0',1764000000000);
INSERT INTO checkout_reversals (checkout_id,type,received_at) VALUES ('checkout_reversals-checkout_id-1','checkout_reversals-type-1',1764000000001);
INSERT INTO checkout_reversals (checkout_id,type,received_at) VALUES ('checkout_reversals-checkout_id-2','checkout_reversals-type-2',1764000000002);
INSERT INTO central_grants (purchase_key,sub,product_id,edition,state,reason,starts_at,ends_at,revision,delivered_revision,attempts,next_attempt_at,last_error,updated_at,features) VALUES ('pk-1','sub-a','hcg.mail','standard','active',NULL,1764000000000,NULL,1,1,0,0,NULL,1764000000000,'[]');
INSERT INTO pub_products (id,title,created_by,created_at) VALUES ('draft-tool','Draft tool','sub-a',1764000000000);
INSERT INTO pub_releases (id,product_id,product_source,edition_id,version,build,channel,release_notes,compatibility,distribution,requested_eligibility,destinations,status,approved_eligibility,created_by,created_at,updated_at,submitted_at,approved_by,approved_at,withdrawn_reason) VALUES ('rel-0000000000000001','draft-tool','draft',NULL,'1.0.0','1','stable','["Notes"]','{"minimumOs":{},"architectures":[],"notes":[]}','paid','public','["hcg-store"]','draft',NULL,'sub-a',1764000000000,1764000000000,NULL,NULL,NULL,NULL);
INSERT INTO pub_releases (id,product_id,product_source,edition_id,version,build,channel,release_notes,compatibility,distribution,requested_eligibility,destinations,status,approved_eligibility,created_by,created_at,updated_at,submitted_at,approved_by,approved_at,withdrawn_reason) VALUES ('rel-0000000000000002','hcg-mail','catalogue','windows-desktop','1.0.0','1','stable','["Notes"]','{"minimumOs":{},"architectures":[],"notes":[]}','paid','public','["hcg-store"]','approved','public','sub-a',1764000000000,1764000000000,1764000000000,'sub-b',1764000000000,NULL);
INSERT INTO pub_artifacts (id,release_id,file_name,platform,format,architectures,minimum_os,size_bytes,declared_sha256,sha256,status,storage_key,content_type,validation,signing_reported,package,created_at,completed_at,declared_kind) VALUES ('art-0000000000000001','rel-0000000000000001','App-Setup.exe','windows','exe','["x64"]','Windows 10',512,'602f5c7e6d387ae3a60ead1e439ca299830614179be43be0482121428578a864',NULL,'awaiting-upload',NULL,'application/vnd.microsoft.portable-executable',NULL,'{"status":"unsigned"}',NULL,1764000000000,NULL,'installer');
INSERT INTO pub_artifacts (id,release_id,file_name,platform,format,architectures,minimum_os,size_bytes,declared_sha256,sha256,status,storage_key,content_type,validation,signing_reported,package,created_at,completed_at,declared_kind) VALUES ('art-0000000000000002','rel-0000000000000002','App-Setup.exe','windows','exe','["x64"]','Windows 10',512,'fe756d4d45d8e0caffdc0ce87e3911b8eae8d09df5487b3efd61a30f31c1b0c4','fe756d4d45d8e0caffdc0ce87e3911b8eae8d09df5487b3efd61a30f31c1b0c4','verified','rel-0000000000000002/art-0000000000000002','application/vnd.microsoft.portable-executable','{"content":null,"signatureStructure":"absent"}','{"status":"unsigned"}',NULL,1764000000000,1764000000000,'installer');
INSERT INTO pub_uploads (artifact_id,received_bytes,staging_key,attempts,updated_at) VALUES ('art-0000000000000001',0,'.uploads/art-0000000000000001.part',0,1764000000000);
INSERT INTO pub_uploads (artifact_id,received_bytes,staging_key,attempts,updated_at) VALUES ('art-0000000000000002',512,'.uploads/art-0000000000000002.part',0,1764000000000);
INSERT INTO pub_download_grants (id_hash,sub,artifact_id,access_token,expires_at) VALUES ('g1','sub-b','art-0000000000000002',NULL,1764000000000);
INSERT INTO pub_audit (seq,at,actor,action,release_id,artifact_id,detail,prev_hash,hash) VALUES (1,1764000000000,'sub-a','release.created','rel-0000000000000002',NULL,'{"version":"1.0.0"}','0000000000000000000000000000000000000000000000000000000000000000','fb35cc6b76e96d8818f335dce93d5e2527d35f9a7f31306fd3e979f66830813a');
INSERT INTO pub_audit (seq,at,actor,action,release_id,artifact_id,detail,prev_hash,hash) VALUES (2,1764000000001,'sub-a','release.submitted','rel-0000000000000002',NULL,'{"files":[]}','fb35cc6b76e96d8818f335dce93d5e2527d35f9a7f31306fd3e979f66830813a','97fc66b06878362aaaf8eeb1f9e83da33ddf823d6bc69ab8c8ca8b3f926750e7');
INSERT INTO pub_audit (seq,at,actor,action,release_id,artifact_id,detail,prev_hash,hash) VALUES (3,1764000000002,'sub-b','release.approved','rel-0000000000000002',NULL,'{"eligibility":"public","current":false}','97fc66b06878362aaaf8eeb1f9e83da33ddf823d6bc69ab8c8ca8b3f926750e7','0fd901e9a12f567fcf9facb9c96b771eaff875999ef5b11be8f2a59c3e8093b3');
INSERT INTO auth_events (id,at,type,session_ref,sub,detail) VALUES (1,1764000000000,'auth_events-type-0','auth_events-session_ref-0','auth_events-sub-0','auth_events-detail-0');
INSERT INTO auth_events (id,at,type,session_ref,sub,detail) VALUES (2,1764000000001,'auth_events-type-1','auth_events-session_ref-1','auth_events-sub-1','auth_events-detail-1');
INSERT INTO auth_events (id,at,type,session_ref,sub,detail) VALUES (3,1764000000002,'auth_events-type-2','auth_events-session_ref-2','auth_events-sub-2','auth_events-detail-2');
INSERT INTO store_profiles (sub,display_name,designation,created_at,updated_at) VALUES ('store_profiles-sub-0','store_profiles-display_name-0','store_profiles-designation-0',1764000000000,1764000000000);
INSERT INTO store_profiles (sub,display_name,designation,created_at,updated_at) VALUES ('store_profiles-sub-1','store_profiles-display_name-1','store_profiles-designation-1',1764000000001,1764000000001);
INSERT INTO store_profiles (sub,display_name,designation,created_at,updated_at) VALUES ('store_profiles-sub-2','store_profiles-display_name-2','store_profiles-designation-2',1764000000002,1764000000002);
INSERT INTO store_profile_events (id,at,sub,action,before_json,after_json,authorised_by,performed_by) VALUES (1,1764000000000,'store_profile_events-sub-0','store_profile_events-action-0','store_profile_events-before_json-0','store_profile_events-after_json-0','store_profile_events-authorised_by-0','store_profile_events-performed_by-0');
INSERT INTO store_profile_events (id,at,sub,action,before_json,after_json,authorised_by,performed_by) VALUES (2,1764000000001,'store_profile_events-sub-1','store_profile_events-action-1','store_profile_events-before_json-1','store_profile_events-after_json-1','store_profile_events-authorised_by-1','store_profile_events-performed_by-1');
INSERT INTO store_profile_events (id,at,sub,action,before_json,after_json,authorised_by,performed_by) VALUES (3,1764000000002,'store_profile_events-sub-2','store_profile_events-action-2','store_profile_events-before_json-2','store_profile_events-after_json-2','store_profile_events-authorised_by-2','store_profile_events-performed_by-2');
COMMIT;
