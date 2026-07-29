# {{MODULE_DISPLAY_NAME}} Execution Skill

> Placeholder skill document for the LM author node of `{{MODULE_NAME}}@{{MODULE_VERSION}}`.
> Replace this with the real prompt guidance the executing worker loads.

## Task

You hold an `{{MODULE_NAME}}.draft` task. Read the input brief, produce a typed
draft envelope conforming to `{{MODULE_NAME}}.output.v1`, and submit it through
the managed node submission protocol.

## Inputs

- Input contract: `{{MODULE_NAME}}.input.v1`
- Work-intent schema: `{{MODULE_NAME}}.work-intent.v1`

## Output

- Output contract: `{{MODULE_NAME}}.output.v1`
- Emitted outcome: `drafted`

## Allowed tools

`Read`, `Write`, `Edit` (see `allowedTools` on the `author` execution profile).

## Retry / recovery

- Max attempts: 2
- Retry on outcome: `draft-rejected`
- On exhausted attempts: `pause`
