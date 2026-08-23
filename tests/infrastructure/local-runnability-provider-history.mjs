/**
 * The AUTHENTIC version→digest history of the factory.local-runnability.v1
 * check provider — the checked expected-history vector for
 * TRUSTED_PROVIDER_BASELINES in
 * src/infrastructure/verification/local-runnability-check-provider.ts.
 *
 * ─── PROVENANCE (how every value was reconstructed) ─────────────────────
 * For each version, `introducedBy` is the git commit that introduced it:
 * the first (and only) commit whose
 * src/modules/development/application/candidate-check-contracts.ts declares
 * `LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION = '<version>'`. Every commit
 * that ever touched that file bumped the version, so each version had
 * exactly ONE digest object (and thus one authentic digest) for its entire
 * lifetime. The digest below is sha256 over that commit's canonical digest
 * object (lexicographically sorted keys, JSON.stringify scalars — the
 * frozen spec of src/shared/canonical-json.ts).
 *
 * These values were reconstructed OUTSIDE the test run, directly from the
 * git blobs of the introducing commits (2026-08-23). They are checked in as
 * the independent oracle ON PURPOSE: generating them from the production
 * table (or from the runtime constants) would be circular and would prove
 * nothing. Never "regenerate" this file from production code. When the
 * provider bumps to a new version, APPEND the new entry (version,
 * introducing commit, digest) and keep every older entry byte-identical.
 *
 * 2026-08-23 repair note: the production table and the earlier test copies
 * had corrupted 1.3.1–1.11.0 values (one hex character duplicated near the
 * tail → 65 chars). Authentic old trust rows were therefore falsely
 * rejected as policy drift. This vector is the corrected, evidence-backed
 * history the production table must conform to.
 */

/** The provider whose history this vector records. */
export const HISTORY_PROVIDER_ID = 'factory.local-runnability.v1';

/**
 * One entry per shipped version, oldest first. `introducedBy` is the full
 * sha of the introducing commit. The LAST entry describes the CURRENT
 * production version (kept for the same append-only discipline).
 */
export const PROVIDER_HISTORY = [
  { version: '1.0.0', introducedBy: '0a63ff78b511e3404e3d190f02328d4824862da8', digest: '93b49183279fa1e94d833d8107ef3a894558c6666cad433fd3e1e9659f510dfb' },
  { version: '1.1.0', introducedBy: '0e08cba71dabf9bb201af07f780910e9a3b26d5f', digest: '19dd6a5c10442e694614a7948c6a4efdbd6ddeb32ccba2720af834e2fa6ff278' },
  { version: '1.2.0', introducedBy: '2aa84485c21be1ce034eb3e308a6a3e261088fb6', digest: 'fbe609a3855c69f772ea51a6ce4a739a343a84569617a296e703610c474c6200' },
  { version: '1.3.0', introducedBy: 'c133b6b0d4a78e4944caacdff0456973126454a4', digest: '13dd611e36fc1e5041b7364cf4f6d57d3dee5dfe4cd36411a36a4627776407e0' },
  { version: '1.3.1', introducedBy: 'f0248e8ea852440bdce4ad016431ff02ecadb088', digest: 'b72ee47d8daa8d3512b8368cfaf4bf5a0fc591f9a3e2084641b0177bf9e6486a' },
  { version: '1.4.0', introducedBy: 'bb968ecfa3e8d85a08aeeccf7b0e26feb5d5e316', digest: 'c9a58ea385cde7dec013fc04be7c131df3091ac6ca78eedcacfd08114811a506' },
  { version: '1.5.0', introducedBy: '493de82fda696f5fedcc7f412b037aa945b8a827', digest: '6908f8ad55f0599bc14d23b1570668df9015db97f6a26a86a44281bfe2362677' },
  { version: '1.6.0', introducedBy: '0747bceeb247c2e37a7328ba145a9626b66f40a1', digest: '52d84078f73d30a61df61e9bdcd46887e627131cee04ccc7c63e2eec8cdd4ef2' },
  { version: '1.7.0', introducedBy: 'a9011b586375b5c03bd931f7c139db59d113f8ba', digest: '66a1a118a49b54c0fec8eae152d54f529b852c361ab78af1f29798ea38223da2' },
  { version: '1.8.0', introducedBy: '7c29c6d61ac14b277cc927271e186c48c70500aa', digest: 'da6e24e63c390efd62005eed27eba8d23f5685f61a1c92c1624f4584ee093c96' },
  { version: '1.9.0', introducedBy: '1e0617c39f8fcd209368238ae5141d0aa0f79960', digest: '0430a19f10201e4ed432757152853c1f9e73004a201fe2bfce9fe492c0bb9881' },
  { version: '1.10.0', introducedBy: '5e39946a2d543989ac29c0149421491d74427f27', digest: '84fd94ebde65e9395a3ab8f875d0408a1303771fabe7f60cce7c26c5a5d00356' },
  { version: '1.11.0', introducedBy: '830bce80f8186765f95cef11ba2313d3f4641ab0', digest: 'f361906c519bbcfdce6e56228790e350726752058d7fe3c9199c0e4bc418263f' },
  { version: '1.12.0', introducedBy: '61fccda7bcf52c0680d9db1c76dbf4307ca09216', digest: 'bd5063ca406b79d0c48bb34e69308dd223c5c14f7b03cc6e4c739709c9100a0a' },
  { version: '1.13.0', introducedBy: '2fbf0b9f318e0f86a414b25eea3683dd1b5023ff', digest: 'e15a26195edad20453cbd21c01e39e034512518526585e6171422d31fa9c7136' },
  // CURRENT production version (as of the 2026-08-23 repair):
  { version: '1.14.0', introducedBy: 'f3a58a30cf6a39d264dff0346a8f7fc9ae09325c', digest: '2e2388159929c58cb6894c92d3613d21181b660c6700e6f146b0276514b9e5f7' },
];

/** The CURRENT entry (last) of the history vector. */
export const CURRENT_PROVIDER_ENTRY = PROVIDER_HISTORY[PROVIDER_HISTORY.length - 1];

/** Every shipped version EXCEPT the current one — the migration-eligible set. */
export const HISTORICAL_PROVIDER_HISTORY = PROVIDER_HISTORY.slice(0, -1);

/** version → authentic digest, for the migration-eligible history only. */
export const HISTORICAL_DIGEST_BY_VERSION = Object.freeze(
  Object.fromEntries(HISTORICAL_PROVIDER_HISTORY.map(entry => [entry.version, entry.digest])),
);
