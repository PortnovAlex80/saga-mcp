# Product Lifecycle Runtime Runbook

## What is executable

`saga3-lifecycle` runs one durable chain:

```text
Product Discovery
  -> Solution Formalization
  -> Solution Development
  -> Delivery / Release
```

The Lifecycle owns cross-module routing and frozen handoffs. Each Process Module
owns only its local flow and local settlement outcome. The generic Runtime owns
leases, retries, task execution, workspaces, checkpoints and persistence.

Standard composition includes:

- generic Discovery and Formalization handlers;
- Development task projection, scoped workers, Git candidate freezing and
  candidate-bound verification;
- Delivery preflight/publication/observation mechanics;
- the external-effect ledger;
- the durable human approval inbox;
- LifecycleRun, StageRun and transition persistence.

Real Delivery preflight, publish/deploy and authoritative observation providers
remain explicit. Saga must not turn a completed task, successful command exit or
Git push into a fabricated release.

## Root input

The CLI accepts one JSON document with schema
`saga3.product-delivery-lifecycle-input.v1`:

```json
{
  "initiative": {
    "subject": "Build a school program that draws a circle through sine and cosine",
    "context": {
      "audience": "secondary-school students"
    },
    "evidence": [],
    "constraints": [
      "Show x = cos(t) and y = sin(t)"
    ]
  },
  "development": {
    "repositories": [
      {
        "projectRepositoryId": 12,
        "integrationBranch": "main",
        "expectedBaseCommit": "FILL_EXACT_COMMIT_SHA"
      }
    ],
    "policy": {
      "id": "standard-development",
      "version": "1.0.0",
      "contentHash": "FILL_CANONICAL_DEVELOPMENT_POLICY_HASH"
    }
  },
  "delivery": {
    "policy": {
      "id": "school-circle-release",
      "version": "1.0.0",
      "contentHash": "FILL_CANONICAL_RELEASE_POLICY_HASH",
      "channel": "production",
      "releaseVersion": "1.0.0",
      "releaseTag": "v1.0.0",
      "humanApprovalRequired": true,
      "requiredPreflightCheckIds": [
        "candidate-integrity"
      ],
      "actions": [
        {
          "actionId": "deploy-school-circle",
          "kind": "deployment",
          "target": "school-circle-production",
          "desiredStateHash": "FILL_DESIRED_STATE_HASH",
          "payloadHash": "FILL_PAYLOAD_HASH",
          "required": true
        }
      ]
    },
    "operatorAuthorization": {
      "schema": "saga3.operator-release-grant.v1",
      "ref": "FILL_IMMUTABLE_GRANT_REF",
      "hash": "FILL_GRANT_HASH",
      "requestedBy": "release-owner",
      "releasePolicyHash": "FILL_SAME_RELEASE_POLICY_HASH",
      "candidateScope": {
        "mode": "lifecycle-output"
      }
    }
  }
}
```

`candidateScope.mode` is deliberately `lifecycle-output`: the exact candidate
does not exist when the complete Lifecycle starts. The Stage Binding later
hands Delivery the exact candidate produced by Development. If human approval
is required, its decision is additionally bound to the exact candidate,
preflight and release-policy hashes.

Compute policy hashes with the production canonical functions before launch:

```js
import { hashDevelopmentPolicy } from './dist/process-modules/modules/development/development-settlement-policy.js';
import { hashDeliveryReleasePolicy } from './dist/process-modules/modules/delivery/delivery-settlement-policy.js';

input.development.policy.contentHash =
  hashDevelopmentPolicy(input.development.policy);
input.delivery.policy.contentHash =
  hashDeliveryReleasePolicy(input.delivery.policy);
input.delivery.operatorAuthorization.releasePolicyHash =
  input.delivery.policy.contentHash;
```

## Delivery composition module

Set `SAGA_PRODUCT_LIFECYCLE_COMPOSITION` to an ESM module exporting
`createProductLifecycleComposition(context)` or a default object/function:

```js
export function createProductLifecycleComposition() {
  const deployer = {
    namespace: 'company-deployer',
    identity: {
      providerId: 42,
      name: 'company-deployer',
      version: '1.0.0',
      category: 'authoritative_state'
    },

    async execute({ action, actionKey }) {
      // Apply the exact desired state with actionKey as the provider-side
      // idempotency key. Return failed/blocked/uncertain instead of guessing.
      throw new Error(`IMPLEMENT_REAL_EXECUTE: ${action.kind}/${actionKey}`);
    },

    async observe({ action, actionKey, externalRef }) {
      // Read the authoritative target. This is also called before a retry.
      throw new Error(
        `IMPLEMENT_AUTHORITATIVE_OBSERVE: ${action.target}/${actionKey}/${externalRef}`
      );
    }
  };

  return {
    delivery: {
      providers: {
        preflight: {
          evaluate({ checkId, deliveryCase }) {
            // Return real evidence plus a trusted provider identity.
            throw new Error(
              `IMPLEMENT_PREFLIGHT: ${checkId}/${deliveryCase.integratedCandidate.hash}`
            );
          }
        },
        actionProviders: {
          deployment: deployer
        },
        observeCurrentCandidateHash(deliveryCase) {
          // Re-read the exact current source/build candidate. Null denies release.
          throw new Error(
            `IMPLEMENT_CURRENT_CANDIDATE_OBSERVATION: ${deliveryCase.integratedCandidate.hash}`
          );
        }
        // approval is omitted: the standard durable inbox is used.
      }
    }
  };
}
```

Every provider identity must match an active row in `trusted_providers` for the
same project (or a global row). Preflight accepts trusted
`deterministic_evidence`/`authoritative_state`; release actions and observations
require `authoritative_state`; approval decisions require
`authorized_decision`.

## Start, inspect, approve and resume

PowerShell:

```powershell
$env:SAGA_ORCHESTRATION_MODE = 'saga3-lifecycle'
$env:SAGA_PRODUCT_LIFECYCLE_COMPOSITION = 'D:\path\delivery-composition.mjs'
$env:SAGA_PRODUCT_LIFECYCLE_INPUT = 'D:\path\product-lifecycle-input.json'
$env:SAGA_INITIATED_BY = 'product-owner'

node dist/orchestrate-cli.js <project_id> <epic_id> --concurrency=4
```

The same environment is inherited when `tracker-view` starts the detached CLI.
The tracker uses the control-plane composition only; external providers are
loaded inside the execution process.

Useful MCP calls:

```text
lifecycle_run_list({ project_id, epic_id })
lifecycle_run_get({ lifecycle_run_id })
delivery_approval_list({ project_id })
delivery_approval_get({ request_id })
delivery_approval_decide({
  request_id,
  status: "approved",
  decided_by,
  rationale,
  provider_id
})
```

Resume the same paused run with the same input and idempotency key:

```powershell
node dist/orchestrate-cli.js <project_id> <epic_id> --resume
```

The default idempotency key is `product-delivery:epic:<epic_id>`. If an explicit
`--idempotency-key` was used for the first launch, pass the same value on resume.
Reusing that key with changed input fails closed.
