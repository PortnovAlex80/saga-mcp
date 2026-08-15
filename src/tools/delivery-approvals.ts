import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SqliteDeliveryApprovalInbox } from '../modules/delivery/infrastructure/sqlite-delivery-approval-inbox.js';
import { getDb } from '../db.js';
import type { ToolHandler } from '../types.js';

let approvalInbox: SqliteDeliveryApprovalInbox | null = null;

function inbox(): SqliteDeliveryApprovalInbox {
  // CONVEYOR Wave 7 — the module no longer defaults to getDb(); the tools
  // adapter (infrastructure) owns concrete construction and passes the handle.
  approvalInbox ??= new SqliteDeliveryApprovalInbox(getDb());
  return approvalInbox;
}

export function _resetDeliveryApprovalInboxForTests(): void {
  approvalInbox = null;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required (non-empty string)`);
  }
  return value.trim();
}

function requiredInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${key} is required (positive integer)`);
  }
  return Number(value);
}

const handleList: ToolHandler = args => {
  const projectId = args.project_id === undefined
    ? undefined
    : requiredInteger(args, 'project_id');
  const requests = inbox().listOpen(projectId);
  return {
    requests,
    count: requests.length,
    next_action: requests.length > 0
      ? 'Review an exact request and call delivery_approval_decide.'
      : 'No open Delivery approval requests.',
  };
};

const handleGet: ToolHandler = args => {
  const requestId = requiredString(args, 'request_id');
  const request = inbox().readRequest(requestId);
  if (!request) {
    throw new Error(`DELIVERY_APPROVAL_REQUEST_NOT_FOUND: ${requestId}`);
  }
  return { request };
};

const handleDecide: ToolHandler = args => {
  const status = requiredString(args, 'status');
  if (!['approved', 'denied', 'expired'].includes(status)) {
    throw new Error(
      `status '${status}' is invalid; expected approved, denied or expired`,
    );
  }
  const result = inbox().recordDecision({
    requestId: requiredString(args, 'request_id'),
    status: status as 'approved' | 'denied' | 'expired',
    decidedBy: requiredString(args, 'decided_by'),
    rationale: requiredString(args, 'rationale'),
    providerId: requiredInteger(args, 'provider_id'),
  });
  return {
    ...result,
    next_action:
      'Resume the same lifecycle run. The Delivery human node will replay '
      + 'this immutable candidate/preflight/policy-bound decision.',
  };
};

export const definitions: Tool[] = [
  {
    name: 'delivery_approval_list',
    description:
      'List open durable Delivery/Release approval requests. Optional '
      + 'project_id narrows the inbox.',
    annotations: {
      title: 'Delivery Approval: List',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delivery_approval_get',
    description:
      'Read one exact Delivery approval request and its immutable candidate, '
      + 'preflight and release-policy binding.',
    annotations: {
      title: 'Delivery Approval: Get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', minLength: 1 },
      },
      required: ['request_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delivery_approval_decide',
    description:
      'Record one immutable authorized decision for an open Delivery request. '
      + 'The provider_id must identify a trusted authorized_decision provider '
      + 'bound to the same project.',
    annotations: {
      title: 'Delivery Approval: Decide',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', minLength: 1 },
        status: {
          type: 'string',
          enum: ['approved', 'denied', 'expired'],
        },
        decided_by: { type: 'string', minLength: 1 },
        rationale: { type: 'string', minLength: 1 },
        provider_id: { type: 'integer', minimum: 1 },
      },
      required: [
        'request_id',
        'status',
        'decided_by',
        'rationale',
        'provider_id',
      ],
      additionalProperties: false,
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  delivery_approval_list: handleList,
  delivery_approval_get: handleGet,
  delivery_approval_decide: handleDecide,
};
