/**
 * W7-RECHECK (2026-08-02) — Thin re-export shim.
 *
 * The concrete SQLite approval inbox (`SqliteDeliveryApprovalInbox`,
 * `ensureDeliveryApprovalInboxSchema`, `DELIVERY_APPROVAL_RECORD_SCHEMA`, and
 * the request/decision record types) physically lives in
 * `src/infrastructure/process-modules/delivery/sqlite-delivery-approval-inbox.ts`
 * after the Wave 7 hex extraction. This file remains ONLY as a re-export so
 * existing importers (sibling modules, the tools adapter, tests) keep
 * resolving. The implementation imports `better-sqlite3` and declares the
 * `Sqlite*` class — neither belongs inside the module tree. A re-export is a
 * pure pass-through: no better-sqlite3 import, no Sqlite class declaration,
 * so it does not trip the physical-placement ratchet
 * (`tests/architecture/no-sqlite-in-modules.test.mjs`).
 *
 * New code MUST import directly from the infrastructure path.
 */
export {
  SqliteDeliveryApprovalInbox,
  ensureDeliveryApprovalInboxSchema,
  DELIVERY_APPROVAL_RECORD_SCHEMA,
  type DeliveryApprovalRequestRecord,
  type RecordDeliveryApprovalDecision,
} from '../../../infrastructure/process-modules/delivery/sqlite-delivery-approval-inbox.js';
